import openstaxInlineFractions from './fixtures/pdf-openstax-inline-fractions.json';
import openstaxNarrowFormulaColumns from './fixtures/pdf-openstax-page908-columns.json';
import openstaxEnergyTable from './fixtures/pdf-openstax-page377-table.json';
import openstaxDensityTable from './fixtures/pdf-openstax-page699-table.json';import openstaxSymbolAtoms from './fixtures/pdf-openstax-page70-symbols.json';
import openstaxColumnAtoms from './fixtures/pdf-openstax-page105-columns.json';
import openstaxListCallout from './fixtures/pdf-openstax-page24-callout.json';
/**
 * @file tests/pdfLayoutAnalysis.test.ts
 * 文件职责：验证 PDF 阅读分析不会把分栏、表格、公式、上下标或插图误当作一个可覆盖的正文框。
 * 主要内容：使用真实绘图操作语义和可复现字形几何验证矩阵、裁剪、行关联、已关联根号的下伸擦除范围、语义边界与阅读顺序；回放实际论文第10、11页的字形/细箭头，确保类型签名名称和交换图标签不进入翻译而邻近正文仍进入，反例约束普通短标题、自然语言解释、页眉页脚、缺失数学端点和粗长短线；回放参考文献的折行 URL 并验证完整地址进入既有字面保护，覆盖普通词、独立地址、段落/分栏不误拼接和长文的几何读取上限；回放发布论文的交错表头、分支公式、下伸大算符和嵌套脚标，保留相同符号的普通正文反例。
 * 模块边界：测试纯分析模块；真实 PDF 提取和来源字节不变由 PDF 解析集成测试补充。
 */
import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {analyzePdfPageLayout, extractPdfGraphicsShapes, pdfLayoutLines, type PdfLayoutAtom} from '@/src/features/document-translation/core/pdfLayoutAnalysis';
import {findDocumentLiteralTerms} from '@/src/core/translation/documentLiterals';
import {protectGlossaryText} from '@/src/core/glossary';

const atom = (text: string, x: number, baseline: number, width = text.length * 5, fontSize = 10): PdfLayoutAtom => ({text, x, y: baseline - fontSize * .8, width, height: fontSize, baseline, fontSize, fontFamily: 'sans-serif'});
const analyze = (atoms: PdfLayoutAtom[], graphics: Parameters<typeof analyzePdfPageLayout>[0]['graphics'] = [], width = 612, height = 792) => analyzePdfPageLayout({atoms, graphics, width, height});
const ops = Object.fromEntries(['save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'constructPath', 'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'endPath'].map((name, index) => [name, index + 1]));

describe('illustrated text inside a page-sized PDF form', () => {
    const frame = {x: 30, y: 0, width: 552, height: 792};
    const wrapper = [{...frame, kind: 'form' as const}, {...frame, x: 30.2, width: 551.8, kind: 'path' as const}];

    it('keeps small text panels distinct from neighboring cards and protected art labels', () => {
        const graphics = [...wrapper,
            {kind: 'path' as const, x: 69, y: 103, width: 102, height: 44},
            {kind: 'path' as const, x: 71, y: 105, width: 102, height: 44},
            {kind: 'path' as const, x: 171, y: 105, width: 97, height: 44},
            {kind: 'image' as const, x: 310, y: 76, width: 145, height: 101},
        ];
        const text = [
            atom('A visitor slept', 86, 120, 65, 9),
            atom('beside the river.', 78, 130, 82, 9),
            atom('Three lights', 186, 124, 62, 9),
            atom('were left on.', 186, 130, 61, 9),
            atom('EAST', 355, 129, 30, 8),
        ];
        const result = analyze(text, graphics);
        expect(result.blocks.filter(block => !block.preserveSource).map(block => block.source)).toEqual([
            'A visitor slept beside the river.', 'Three lights were left on.',
        ]);
        expect(result.blocks.find(block => block.source === 'EAST')).toMatchObject({kind: 'figure-label', preserveSource: true});
        expect(result.blocks[0]).toMatchObject({panelBounds: {x: 69, y: 103, width: 102, height: 44}});
        expect(result.blocks[0].lines).toHaveLength(2);
        expect(result.preservedRegions.every(region => region.height < frame.height)).toBe(true);
    });

    it('does not let the merged bounds of overlapping figures cover adjacent text', () => {
        const graphics = [...wrapper,
            {kind: 'image' as const, x: 100, y: 80, width: 290, height: 180},
            {kind: 'image' as const, x: 340, y: 230, width: 220, height: 200},
        ];
        const result = analyze([atom('Read both rules.', 112, 300, 120), atom('WATER', 420, 300, 42)], graphics);
        expect(result.blocks.find(block => block.source === 'Read both rules.')).toMatchObject({kind: 'text', preserveSource: false});
        expect(result.blocks.find(block => block.source === 'WATER')).toMatchObject({kind: 'figure-label', preserveSource: true});
        expect(result.preservedRegions.some(region => region.kind === 'figure' && region.height === 350)).toBe(true);
    });

    it('keeps a panel list marker while separating a row of map labels from its caption', () => {
        const graphics = [...wrapper,
            {kind: 'path' as const, x: 60, y: 101, width: 130, height: 49},
            {kind: 'image' as const, x: 300, y: 80, width: 255, height: 165},
        ];
        const result = analyze([
            atom('•', 72, 120, 5), atom('A list item wraps', 81, 120, 79), atom('onto a second line.', 80, 131, 78),
            atom('oak elm ash pine fir birch yew', 321, 155, 190),
            atom('This legend shows the names of local trees.', 321, 180, 195),
        ], graphics);
        expect(result.blocks.find(block => block.source === 'A list item wraps onto a second line.')).toMatchObject({
            kind: 'text', listMarker: '•', panelBounds: {x: 60, y: 101, width: 130, height: 49},
        });
        expect(result.blocks.find(block => block.source.startsWith('oak elm'))).toMatchObject({kind: 'figure-label', preserveSource: true});
        expect(result.blocks.find(block => block.source.startsWith('This legend'))).toMatchObject({kind: 'text', preserveSource: false});
    });

    it.each([
        ['short labels', [atom('East', 75, 120, 22), atom('West.', 75, 132, 24)]],
        ['misaligned rows', [atom('Near the river', 75, 120, 55), atom('read the sign.', 130, 132, 59)]],
        ['discontinuous baselines', [atom('Near the river', 75, 120, 55), atom('read the sign.', 75, 145, 59)]],
        ['dense glyphs', Array.from({length: 151}, () => atom('North.', 75, 120, 35))],
    ] as const)('does not classify %s as a small text panel', (_kind, text) => {
        const result = analyze([...text], [...wrapper, {kind: 'path', x: 60, y: 100, width: 140, height: 60}]);
        expect(result.blocks.length).toBeGreaterThan(0);
        expect(result.blocks.every(block => !block.panelBounds)).toBe(true);
    });

    it('leaves the ordinary analysis in charge when the page has too many candidate backdrops', () => {
        const text = [atom('Keep the clue', 75, 120, 55), atom('beside its title.', 75, 132, 58)];
        const backdrop = {kind: 'path' as const, x: 60, y: 100, width: 140, height: 60};
        const result = analyze(text, [...wrapper, ...Array.from({length: 129}, () => ({...backdrop}))]);
        expect(result.blocks.every(block => !block.panelBounds)).toBe(true);
    });
});

describe('letter-spaced supported section headings', () => {
    // Smith & Levy (2013), Cognition128 pp302–319, doi:10.1016/j.cognition.2013.02.013, source PDF p1.
    // Source SHA7c325f95f5b54bc529e9c8793d26651c306841c4d1c6b64303997db47a74df77; source p1 states Creative Commons Attribution License.
    // The first case retains only three source atoms and all four relevant horizontal paths from the 89-atom/26-shape page; other prose is self-authored.
    const original: PdfLayoutAtom = {text: 'a b s t r a c t', x: 200.1259, y: 265.0100742, width: 65.24148868999998,
        height: 8.9663, fontFamily: 'serif', baseline: 270.08500000000004, fontSize: 8.9663};
    const prose = (extra: Partial<PdfLayoutAtom> = {}): PdfLayoutAtom => ({...atom('This paragraph explains the study and its main result.', 200.0125, 289.7574, 307.3733, 7.1731), ...extra});

    it('recovers the actual Smith-Levy abstract heading without rewriting its spaced source or glyph geometry', () => {
        const input = [original,
            {text: 'It is well known that real-time human language processing is highly incremental and con-', x: 200.0125, y: 284.0978241, width: 307.3733474899999, height: 7.1731, fontFamily: 'serif', baseline: 289.7574, fontSize: 7.1731},
            {text: 'text-driven, and that the strength of a comprehender’s expectation for each word encoun-', x: 200.0125, y: 293.67893377, width: 307.40355095999985, height: 7.1731, fontFamily: 'serif', baseline: 299.33850967, fontSize: 7.1731}];
        const graphics = [
            {x: 41.159, y: 250.12925, width: 466.242, height: 0.22674999999998136, kind: 'path' as const},
            {x: 41.159, y: 279.94919000000004, width: 133.228, height: 0.2268100000000004, kind: 'path' as const},
            {x: 41.159, y: 334.26122, width: 133.228, height: 0.2267800000000193, kind: 'path' as const},
            {x: 200.013, y: 279.89252000000005, width: 307.446, height: 0.2834799999999973, kind: 'path' as const},
        ], before = structuredClone({input, graphics});
        const result = analyze(input, graphics, 544.252, 742.677);
        expect(result.blocks.find(block => block.source === original.text)).toMatchObject({kind: 'heading', preserveSource: false, lines: [{runs: [original]}]});
        expect(result.blocks.flatMap(block => block.lines!.flatMap(line => line.runs!))).toEqual(input);
        expect(result.preservedRegions.some(region => region.kind === 'table' && region.y < original.baseline && region.y + region.height > original.baseline)).toBe(false);
        expect({input, graphics}).toEqual(before);
    });

    it.each(['connected', 'single edge', 'repeated edge', 'disconnected edges', 'outside edges'] as const)('joins unequal-width table rows only with two real connecting column edges: %s', mode => {
        const graphics = [{kind: 'path' as const, x: 200, y: 100, width: 180, height: 0},
            ...[160, 180].map(y => ({kind: 'path' as const, x: 50, y, width: 480, height: 0}))];
        const xs = mode === 'single edge' ? [200] : mode === 'repeated edge' ? [200, 201] : mode === 'outside edges' ? [40, 550] : [200, 380];
        graphics.push(...xs.map(x => ({kind: 'path' as const, x, y: mode === 'disconnected edges' ? 120 : 100, width: 0, height: mode === 'disconnected edges' ? 40 : 60})));
        const result = analyze([atom('Merged group header', 210, 114, 160), atom('Lower table left label', 60, 174, 150), atom('Lower table right label', 300, 174, 180)], graphics);
        expect(result.preservedRegions.find(region => region.kind === 'table')).toMatchObject({x: 50, width: 480, y: mode === 'connected' ? 99 : 159});
        expect(result.blocks.find(block => block.source === 'Merged group header')?.kind === 'table').toBe(mode === 'connected');
    });

    it.each([336, 335.9])('preserves the inclusive .7 similar-width boundary without inventing column edges: %s', width => {
        const graphics = [{kind: 'path' as const, x: 50, y: 100, width, height: 0}, ...[160, 180].map(y => ({kind: 'path' as const, x: 50, y, width: 480, height: 0}))];
        const result = analyze([atom('Group header', 60, 114, 180), atom('Lower table label', 60, 174, 180)], graphics);
        expect(result.preservedRegions.find(region => region.kind === 'table')?.y).toBe(width === 336 ? 99 : 159);
        expect(result.blocks.find(block => block.source === 'Group header')?.kind === 'table').toBe(width === 336);
    });

    it.each(['A B S T R A C T', 'A b s t r a c t', 'r e f e r e n c e s', 'A C K N O W L E D G M E N T S', 'a c k n o w l e d g e m e n t s', 'A P P E N D I X', 'A P P E N D I X  A'])
    ('recognizes the supported tracked section name %s while retaining its exact source runs', text => {
        const title = {...original, text};
        expect(analyze([title, prose()]).blocks.find(block => block.source === text.replace(/ +/gu, ' '))).toMatchObject({kind: 'heading', preserveSource: false, lines: [{runs: [title]}]});
    });

    it.each(['a r t i c l e i n f o', 'a b c d e f g h', 'A. B. S. T. R. A. C. T.', 'α β γ δ ε ζ η θ', 'a\u00a0b\u00a0s\u00a0t\u00a0r\u00a0a\u00a0c\u00a0t', 'A '.repeat(42) + 'A'])
    ('does not promote unsupported letter lists, punctuation, policy metadata or other whitespace: %s', text => {
        const result = analyze([{...original, text}, prose()]);
        // Existing line whitespace normalization stays intact; original run text must remain unchanged.
        expect(result.blocks.find(block => block.source === text.replace(/\s+/gu, ' '))).toMatchObject({kind: 'formula', preserveSource: true, lines: [{runs: [{text}]}]});
    });

    it.each(['missing', 'far below', 'other column', 'larger font', 'smaller font', 'symbols only', 'short words', 'above title'] as const)
    ('requires supporting same-column prose rather than %s context', mode => {
        const body = prose();
        if (mode === 'far below') body.baseline = body.y = 500;
        if (mode === 'other column') body.x = 400;
        if (mode === 'larger font') body.fontSize = 20;
        if (mode === 'smaller font') body.fontSize = 4;
        if (mode === 'symbols only') body.text = 'a b c d e f g h';
        if (mode === 'short words') body.text = 'Short explanation';
        if (mode === 'above title') {body.baseline = 250; body.y = 240;}
        expect(analyze([original, ...(mode === 'missing' ? [] : [body])]).blocks.find(block => block.source === original.text))
            .toMatchObject({kind: 'formula', preserveSource: true});
    });

    it('keeps letter variables in a protected equation and genuine table cell instead of inferring a section', () => {
        const title = atom('a b s t r a c t', 200, 100, 65);
        const body = atom('This paragraph explains the notation in the following study.', 200, 130, 300);
        expect(analyze([title, atom('x = y + z', 200, 112, 70), body]).blocks.find(block => block.source.includes(title.text)))
            .toMatchObject({kind: 'formula', preserveSource: true});
        const graphics = [{kind: 'path' as const, x: 190, y: 85, width: 0, height: 55}, {kind: 'path' as const, x: 550, y: 85, width: 0, height: 55},
            ...[85, 115, 140].map(y => ({kind: 'path' as const, x: 190, y, width: 360, height: 0}))];
        expect(analyze([title, body], graphics).blocks.find(block => block.source === title.text)).toMatchObject({kind: 'table', preserveSource: true});
    });

    it('keeps page furniture and author-grid initials preserved even when their letters spell a section name', () => {
        const footer = atom('a b s t r a c t', 50, 20, 65);
        expect(analyze([footer, atom('This paragraph explains the entire ordinary study in detail.', 50, 100, 300)]).blocks.find(block => block.source === footer.text))
            .toMatchObject({kind: 'footer', preserveSource: true});
        const initials = atom('A B S T R A C T', 50, 100, 100);
        const result = analyze([initials, atom('Alice Example', 210, 100, 80), atom('Bob Example', 380, 100, 80),
            atom('author@example.test', 50, 112, 100), atom('This paragraph explains the complete experimental study in detail.', 50, 130, 400)]);
        expect(result.blocks.find(block => block.source === initials.text)).toMatchObject({preserveSource: true});
        expect(result.blocks.find(block => block.source === initials.text)?.kind).not.toBe('heading');
    });
});

// 本机公开 PDF 2608.25512v1 第10页，source SHA256 390775dbc9debdcf2ed1b076eed013387ca057630be3cb594617b2b742e48cf0；由实际 PDF.js/pdfTextAtoms 提取，未包含任何机器翻译结果。
const pageTenMathGeometry = {
    width: 595.2756, height: 841.8898,
    atoms: ([
        ["Definition",70.86614,304.81940000000003,51.93099999999999,11,312.73940000000005,11,"sans-serif"],
        ["3",125.54714,304.81940000000003,5.5,11,312.73940000000005,11,"sans-serif"],
        [".",131.04713,304.81940000000003,2.75,11,312.73940000000005,11,"sans-serif"],
        ["Define the transformation",136.54713,304.75340000000006,125.68599999999998,11.077000000000002,312.73940000000005,11,"sans-serif"],
        ["track",264.98315,303.87340000000006,24.782999999999998,11,312.73940000000005,11,"sans-serif"],
        ["Γ",289.76614,309.2502,5.4362,7.7,315.45640000000003,7.7,"sans-serif"],
        ["on pairs of context functions:",298.56833,304.75340000000006,140.90999999999997,11.077000000000002,312.73940000000005,11,"sans-serif"],
        ["track",154.18387,324.23640000000006,24.782999999999998,11,333.10240000000005,11,"sans-serif"],
        ["Γ",178.96686,329.6132,5.4362,7.7,335.81940000000003,7.7,"sans-serif"],
        [":",196.01906,324.23640000000006,3.058,11,333.10240000000005,11,"sans-serif"],
        ["(",210.07706,324.23640000000006,4.279,11,333.10240000000005,11,"sans-serif"],
        ["Γ",214.35606,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        ["→",224.28662,324.23640000000006,11,11,333.10240000000005,11,"sans-serif"],
        ["Γ",238.34218,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        [")",245.21718,324.23640000000006,4.279,11,333.10240000000005,11,"sans-serif"],
        ["×",251.94061,324.23640000000006,8.558,11,333.10240000000005,11,"sans-serif"],
        ["(",262.94305,324.23640000000006,4.279,11,333.10240000000005,11,"sans-serif"],
        ["Γ",267.22208,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        ["→",277.15262,324.23640000000006,11,11,333.10240000000005,11,"sans-serif"],
        ["Γ",291.20816,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        [")",298.08316,324.23640000000006,4.279,11,333.10240000000005,11,"sans-serif"],
        ["→",310.61218,324.23640000000006,11,11,333.10240000000005,11,"sans-serif"],
        ["𝜕",336.61984,324.23640000000006,5.840999999999999,11,333.10240000000005,11,"sans-serif"],
        ["Γ",343.15384,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        ["→",365.0365,324.23640000000006,11,11,333.10240000000005,11,"sans-serif"],
        ["𝜕",405.98462,324.23640000000006,5.840999999999999,11,333.10240000000005,11,"sans-serif"],
        ["Γ",412.51862,324.23640000000006,6.875,11,333.10240000000005,11,"sans-serif"],
        ["track",154.18387,342.74940000000004,24.782999999999998,11,351.6154,11,"sans-serif"],
        ["Γ",178.96686,348.12620000000004,5.4362,7.7,354.33240000000006,7.7,"sans-serif"],
        ["=",193.26906,342.74940000000004,8.558,11,351.6154,11,"sans-serif"],
        ["(",243.54395,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["𝑓",247.82295,342.74940000000004,5.39,11,351.6154,11,"sans-serif"],
        [",",254.20296,342.74940000000004,3.058,11,351.6154,11,"sans-serif"],
        ["𝑔",259.0943,342.74940000000004,5.247,11,351.6154,11,"sans-serif"],
        [")",264.61627,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["↦",310.73868,342.74940000000004,10.747,11,351.6154,11,"sans-serif"],
        ["(",329.86218,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["𝛾",334.14117,342.74940000000004,5.6979999999999995,11,351.6154,11,"sans-serif"],
        [",",340.42218,342.74940000000004,3.058,11,351.6154,11,"sans-serif"],
        ["𝜑",345.3135,342.74940000000004,7.194,11,351.6154,11,"sans-serif"],
        [")",352.5075,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["↦",365.163,342.74940000000004,10.747,11,351.6154,11,"sans-serif"],
        ["(",384.2865,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["𝑓",388.56552,342.74940000000004,5.39,11,351.6154,11,"sans-serif"],
        ["(",394.9455,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["𝛾",399.22452,342.74940000000004,5.6979999999999995,11,351.6154,11,"sans-serif"],
        [")",405.5055,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        [",",409.78452,342.74940000000004,3.058,11,351.6154,11,"sans-serif"],
        ["𝜑",414.67584,342.74940000000004,7.194,11,351.6154,11,"sans-serif"],
        ["∘",424.31427,342.74940000000004,4.532,11,351.6154,11,"sans-serif"],
        ["𝑔",431.29074,342.74940000000004,5.247,11,351.6154,11,"sans-serif"],
        [")",436.8127,342.74940000000004,4.279,11,351.6154,11,"sans-serif"],
        ["(6)",510.35144,332.48640000000006,14.058,11,341.35240000000005,11,"sans-serif"],
        ["This transformation converts a forward function",87.36614,368.0914,233.46488706970007,11.077000000000002,376.0774,11,"sans-serif"],
        ["𝑓",323.5812,367.2114,5.39,11,376.0774,11,"sans-serif"],
        ["together with a candidate inverse",332.71137741394,368.0914,161.6347096557601,11.077000000000002,376.0774,11,"sans-serif"],
        ["𝑔",497.09628,367.2114,5.247,11,376.0774,11,"sans-serif"],
        ["into",505.36847741393996,368.0914,19.040999999999986,11.077000000000002,376.0774,11,"sans-serif"],
        ["a transformation of the effect context",70.86614,381.75340000000006,181.26222950000002,11.077000000000002,389.73940000000005,11,"sans-serif"],
        ["𝜕",255.47762,380.87340000000006,5.840999999999999,11,389.73940000000005,11,"sans-serif"],
        ["Γ",262.01163,380.87340000000006,6.875,11,389.73940000000005,11,"sans-serif"],
        [". Applying",268.88663,381.75340000000006,52.59624589999994,11.077000000000002,389.73940000000005,11,"sans-serif"],
        ["track",324.83212,380.87340000000006,24.782999999999998,11,389.73940000000005,11,"sans-serif"],
        ["Γ",349.6151,386.2502,5.4362,7.7,392.45640000000003,7.7,"sans-serif"],
        ["(",355.6673,380.87340000000006,4.279,11,389.73940000000005,11,"sans-serif"],
        ["𝑓",359.94632,380.87340000000006,5.39,11,389.73940000000005,11,"sans-serif"],
        [",",366.3263,380.87340000000006,3.058,11,389.73940000000005,11,"sans-serif"],
        ["𝑔",371.21765,380.87340000000006,5.247,11,389.73940000000005,11,"sans-serif"],
        [")",376.73965,380.87340000000006,4.279,11,389.73940000000005,11,"sans-serif"],
        ["to a state",384.3678959,381.75340000000006,44.120491800000075,11.077000000000002,389.73940000000005,11,"sans-serif"],
        ["(",431.83762,380.87340000000006,4.279,11,389.73940000000005,11,"sans-serif"],
        ["𝛾",436.11664,380.87340000000006,5.6979999999999995,11,389.73940000000005,11,"sans-serif"],
        [",",442.3976,380.87340000000006,3.058,11,389.73940000000005,11,"sans-serif"],
        ["𝜑",447.28897,380.87340000000006,7.194,11,389.73940000000005,11,"sans-serif"],
        [")",454.48297,380.87340000000006,4.279,11,389.73940000000005,11,"sans-serif"],
        ["transforms",462.1112059,381.75340000000006,52.66800000000003,11.077000000000002,389.73940000000005,11,"sans-serif"],
        ["𝛾",518.1285,380.87340000000006,5.6979999999999995,11,389.73940000000005,11,"sans-serif"],
        ["by",70.86614,395.41540000000003,11.869,11.077000000000002,403.4014,11,"sans-serif"],
        ["𝑓",85.48514,394.53540000000004,5.39,11,403.4014,11,"sans-serif"],
        ["and composes the inverse",94.61514,395.41540000000003,124.38800000000002,11.077000000000002,403.4014,11,"sans-serif"],
        ["𝑔",221.75314,394.53540000000004,5.247,11,403.4014,11,"sans-serif"],
        ["onto",230.02515,395.41540000000003,21.89000000000001,11.077000000000002,403.4014,11,"sans-serif"],
        ["𝜑",254.66515,394.53540000000004,7.194,11,403.4014,11,"sans-serif"],
        [", thereby tracking the effect of",261.85913,395.41540000000003,144.298,11.077000000000002,403.4014,11,"sans-serif"],
        ["𝑓",408.90714,394.53540000000004,5.39,11,403.4014,11,"sans-serif"],
        ["in the context.",418.03714,395.41540000000003,68.64000000000001,11.077000000000002,403.4014,11,"sans-serif"],
        ["Theorem",70.86614,419.9434,45.232,11,427.8634,11,"sans-serif"],
        ["4",119.29805,419.9434,5.5,11,427.8634,11,"sans-serif"],
        [".",124.79805,419.9434,2.75,11,427.8634,11,"sans-serif"],
        ["For every",130.747962023,419.8774,46.220912023000025,11.077000000000002,427.8634,11,"sans-serif"],
        ["(",180.1688,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["𝑓",184.44778,418.9974,5.39,11,427.8634,11,"sans-serif"],
        [",",190.82779,418.9974,3.058,11,427.8634,11,"sans-serif"],
        ["𝑔",195.71912,418.9974,5.247,11,427.8634,11,"sans-serif"],
        [")",201.24112,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["∈",208.57568,418.9974,7.337,11,427.8634,11,"sans-serif"],
        ["(",218.96823,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["Γ",223.24724,418.9974,6.875,11,427.8634,11,"sans-serif"],
        ["→",233.1778,418.9974,11,11,427.8634,11,"sans-serif"],
        ["Γ",247.23334,418.9974,6.875,11,427.8634,11,"sans-serif"],
        [")",254.10834,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["×",260.8318,418.9974,8.558,11,427.8634,11,"sans-serif"],
        ["(",271.83423,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["Γ",276.11322,418.9974,6.875,11,427.8634,11,"sans-serif"],
        ["→",286.0438,418.9974,11,11,427.8634,11,"sans-serif"],
        ["Γ",300.09933,418.9974,6.875,11,427.8634,11,"sans-serif"],
        [")",306.97433,418.9974,4.279,11,427.8634,11,"sans-serif"],
        [", write",311.25336,419.8774,31.480912023000023,11.077000000000002,427.8634,11,"sans-serif"],
        ["𝑓",345.93417,418.9974,5.39,11,427.8634,11,"sans-serif"],
        ["′",352.31418,417.6642,3.1339,7.7,423.8704,7.7,"sans-serif"],
        ["≔",359.11963,418.9974,9.966,11,427.8634,11,"sans-serif"],
        ["track",372.14117,418.9974,24.782999999999998,11,427.8634,11,"sans-serif"],
        ["Γ",396.9242,424.37420000000003,5.4362,7.7,430.58040000000005,7.7,"sans-serif"],
        ["(",402.97638,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["𝑓",407.25537,418.9974,5.39,11,427.8634,11,"sans-serif"],
        [",",413.63538,418.9974,3.058,11,427.8634,11,"sans-serif"],
        ["𝑔",418.5267,418.9974,5.247,11,427.8634,11,"sans-serif"],
        [")",424.0487,418.9974,4.279,11,427.8634,11,"sans-serif"],
        ["; then the following",428.32773,419.8774,96.081736069,11.077000000000002,427.8634,11,"sans-serif"],
        ["diagram commutes, that is,",70.86614,433.53940000000006,132.32999999999998,11.077000000000002,441.52540000000005,11,"sans-serif"],
        ["pr",257.2021,453.72970000000004,10.427999999999999,11,462.5957,11,"sans-serif"],
        ["1",267.6301,459.10650000000004,4.3813,7.7,465.31270000000006,7.7,"sans-serif"],
        ["∘",275.07184,453.72970000000004,4.532,11,462.5957,11,"sans-serif"],
        ["𝑓",282.04828,453.72970000000004,5.39,11,462.5957,11,"sans-serif"],
        ["′",288.42828,452.3965,3.1339,7.7,458.6027,7.7,"sans-serif"],
        ["=",295.23373,453.72970000000004,8.558,11,462.5957,11,"sans-serif"],
        ["𝑓",306.8473,453.72970000000004,5.39,11,462.5957,11,"sans-serif"],
        ["∘",315.67175,453.72970000000004,4.532,11,462.5957,11,"sans-serif"],
        ["pr",322.6482,453.72970000000004,10.427999999999999,11,462.5957,11,"sans-serif"],
        ["1",333.0762,459.10650000000004,4.3813,7.7,465.31270000000006,7.7,"sans-serif"],
        ["(7)",510.35144,453.72970000000004,14.058,11,462.5957,11,"sans-serif"],
        ["𝑓",294.7378,478.9327,4.9,10,486.9927,10,"sans-serif"],
        ["𝑓",293.0333,550.8127000000001,4.9,10,558.8727,10,"sans-serif"],
        ["′",298.83328,549.6007,2.849,7,555.2427,7,"sans-serif"],
        ["pr",247.51979,515.2696800000001,9.48,10,523.32968,10,"sans-serif"],
        ["1",256.9998,520.1577,3.983,7,525.7997,7,"sans-serif"],
        ["pr",333.7328,515.2696800000001,9.48,10,523.32968,10,"sans-serif"],
        ["1",343.2128,520.1577,3.983,7,525.7997,7,"sans-serif"],
        ["track",301.6378,515.8426800000001,22.53,10,523.90268,10,"sans-serif"],
        ["Γ",262.4178,488.39770000000004,6.25,10,496.45770000000005,10,"sans-serif"],
        ["Γ",326.6078,488.39770000000004,6.25,10,496.45770000000005,10,"sans-serif"],
        ["𝜕",259.44778,543.3976700000001,5.3100000000000005,10,551.45767,10,"sans-serif"],
        ["Γ",265.3878,543.3976700000001,6.25,10,551.45767,10,"sans-serif"],
        ["𝜕",323.6378,543.3976700000001,5.3100000000000005,10,551.45767,10,"sans-serif"],
        ["Γ",329.5778,543.3976700000001,6.25,10,551.45767,10,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
    graphics: [{"x":276.1718,"y":493.0427,"width":42.691956000000005,"height":0,"kind":"path"},{"x":277.6378,"y":548.0427,"width":39.75999999999999,"height":0,"kind":"path"},{"x":265.5428,"y":503.91170000000005,"width":0,"height":34.71597700000001,"kind":"path"},{"x":329.7328,"y":503.91170000000005,"width":0,"height":34.71597700000001,"kind":"path"},{"x":296.6778,"y":498.5427,"width":0,"height":42.113099999999974,"kind":"path"},{"x":298.5978,"y":498.5427,"width":0,"height":42.113099999999974,"kind":"path"}] as Parameters<typeof analyzePdfPageLayout>[0]['graphics'],
};

// 同一公开 PDF 第11页，source SHA256 390775dbc9debdcf2ed1b076eed013387ca057630be3cb594617b2b742e48cf0；实际字形、箭头路径与上下正文，不含译文。
const pageElevenMathGeometry = {
    width: 595.2756, height: 841.8898,
    atoms: ([
        ["Definition",70.86614,242.62140000000008,51.93099999999999,11,250.54140000000007,11,"sans-serif"],
        ["6",125.54714,242.62140000000008,5.5,11,250.54140000000007,11,"sans-serif"],
        [".",131.04713,242.62140000000008,2.75,11,250.54140000000007,11,"sans-serif"],
        ["Define the transformation",136.54713,242.55540000000008,125.68599999999998,11.077000000000002,250.54140000000007,11,"sans-serif"],
        ["recover",264.98315,241.67540000000008,34.583999999999996,11,250.54140000000007,11,"sans-serif"],
        ["Γ",299.56714,247.05220000000006,5.4362,7.7,253.25840000000005,7.7,"sans-serif"],
        ["on",308.36935,242.55540000000008,12.407999999999998,11.077000000000002,250.54140000000007,11,"sans-serif"],
        ["𝜕",323.52734,241.67540000000008,5.840999999999999,11,250.54140000000007,11,"sans-serif"],
        ["Γ",330.06134,241.67540000000008,6.875,11,250.54140000000007,11,"sans-serif"],
        [":",336.93634,242.55540000000008,2.75,11.077000000000002,250.54140000000007,11,"sans-serif"],
        ["recover",212.22426,262.0384,34.583999999999996,11,270.9044,11,"sans-serif"],
        ["Γ",246.80826,267.41517000000005,5.4362,7.7,273.62137000000007,7.7,"sans-serif"],
        [":",263.86047,262.0384,3.058,11,270.9044,11,"sans-serif"],
        ["𝜕",284.67612,262.0384,5.840999999999999,11,270.9044,11,"sans-serif"],
        ["Γ",291.2101,262.0384,6.875,11,270.9044,11,"sans-serif"],
        ["→",313.0928,262.0384,11,11,270.9044,11,"sans-serif"],
        ["𝜕",350.99255,262.0384,5.840999999999999,11,270.9044,11,"sans-serif"],
        ["Γ",357.52655,262.0384,6.875,11,270.9044,11,"sans-serif"],
        ["recover",212.22426,280.55140000000006,34.583999999999996,11,289.41740000000004,11,"sans-serif"],
        ["Γ",246.80826,285.9282,5.4362,7.7,292.1344,7.7,"sans-serif"],
        ["=",261.11047,280.55140000000006,8.558,11,289.41740000000004,11,"sans-serif"],
        ["(",277.91846,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        ["𝛾",282.19745,280.55140000000006,5.6979999999999995,11,289.41740000000004,11,"sans-serif"],
        [",",288.47845,280.55140000000006,3.058,11,289.41740000000004,11,"sans-serif"],
        ["𝜑",293.36978,280.55140000000006,7.194,11,289.41740000000004,11,"sans-serif"],
        [")",300.56378,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        ["↦",313.2193,280.55140000000006,10.747,11,289.41740000000004,11,"sans-serif"],
        ["(",332.3428,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        ["𝜑",336.6218,280.55140000000006,7.194,11,289.41740000000004,11,"sans-serif"],
        ["(",343.8158,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        ["𝛾",348.0948,280.55140000000006,5.6979999999999995,11,289.41740000000004,11,"sans-serif"],
        [")",354.3758,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        [",",358.6548,280.55140000000006,3.058,11,289.41740000000004,11,"sans-serif"],
        ["id",363.54614,280.55140000000006,9.174,11,289.41740000000004,11,"sans-serif"],
        ["Γ",372.72012,285.9282,5.4362,7.7,292.1344,7.7,"sans-serif"],
        [")",378.77234,280.55140000000006,4.279,11,289.41740000000004,11,"sans-serif"],
        ["(9)",510.35144,270.2884,14.058,11,279.1544,11,"sans-serif"],
        ["This transformation applies the recovery function",87.36614,305.89340000000004,237.79872088499997,11.077000000000002,313.87940000000003,11,"sans-serif"],
        ["𝜑",327.387,305.01340000000005,7.194,11,313.87940000000003,11,"sans-serif"],
        ["to the current state",336.80314417700004,305.89340000000004,89.47443253100005,11.077000000000002,313.87940000000003,11,"sans-serif"],
        ["𝛾",428.49973,305.01340000000005,5.6979999999999995,11,313.87940000000003,11,"sans-serif"],
        ["and resets",437.002874177,305.89340000000004,48.64214417700001,11.077000000000002,313.87940000000003,11,"sans-serif"],
        ["𝜑",487.86716,305.01340000000005,7.194,11,313.87940000000003,11,"sans-serif"],
        ["to the",497.283304177,305.89340000000004,27.126144177000022,11.077000000000002,313.87940000000003,11,"sans-serif"],
        ["identity. The following diagram illustrates how",70.86614,319.5554000000001,230.59219535000005,11.077000000000002,327.54140000000007,11,"sans-serif"],
        ["recover",304.679,318.6754000000001,34.583999999999996,11,327.54140000000007,11,"sans-serif"],
        ["recovers the context to its initial state",342.48360907,319.5554000000001,181.92583442,11.077000000000002,327.54140000000007,11,"sans-serif"],
        ["after a sequence of effects",70.86614,333.21740000000005,123.717,11.077000000000002,341.20340000000004,11,"sans-serif"],
        ["𝑓",197.33315,332.33740000000006,5.39,11,341.20340000000004,11,"sans-serif"],
        ["′",203.71313,331.0042,3.1339,7.7,337.21040000000005,7.7,"sans-serif"],
        ["𝑖",202.72314,337.7142,3.1108000000000002,7.7,343.92040000000003,7.7,"sans-serif"],
        ["≔",210.5186,332.33740000000006,9.966,11,341.20340000000004,11,"sans-serif"],
        ["track",223.54015,332.33740000000006,24.782999999999998,11,341.20340000000004,11,"sans-serif"],
        ["Γ",248.32315,337.7142,5.4362,7.7,343.92040000000003,7.7,"sans-serif"],
        ["(",254.37535,332.33740000000006,4.279,11,341.20340000000004,11,"sans-serif"],
        ["𝑓",258.65436,332.33740000000006,5.39,11,341.20340000000004,11,"sans-serif"],
        ["𝑖",264.04434,337.7142,3.1108000000000002,7.7,343.92040000000003,7.7,"sans-serif"],
        [",",267.77115,332.33740000000006,3.058,11,341.20340000000004,11,"sans-serif"],
        ["𝑔",272.66248,332.33740000000006,5.247,11,341.20340000000004,11,"sans-serif"],
        ["𝑖",277.9095,337.7142,3.1108000000000002,7.7,343.92040000000003,7.7,"sans-serif"],
        [")",281.6363,332.33740000000006,4.279,11,341.20340000000004,11,"sans-serif"],
        [",",285.91528,333.21740000000005,2.75,11.077000000000002,341.20340000000004,11,"sans-serif"],
        ["𝑖",291.41528,332.33740000000006,3.795,11,341.20340000000004,11,"sans-serif"],
        ["=",298.26584,332.33740000000006,8.558,11,341.20340000000004,11,"sans-serif"],
        ["1",309.8794,332.33740000000006,5.5,11,341.20340000000004,11,"sans-serif"],
        [",",315.3794,332.33740000000006,3.058,11,341.20340000000004,11,"sans-serif"],
        ["⋯",320.27072,332.33740000000006,8.536,11,341.20340000000004,11,"sans-serif"],
        [",",328.80673,332.33740000000006,3.058,11,341.20340000000004,11,"sans-serif"],
        ["𝑛",333.69806,332.33740000000006,6.6,11,341.20340000000004,11,"sans-serif"],
        [", has been applied to",340.29807,333.21740000000005,99.89099999999998,11.077000000000002,341.20340000000004,11,"sans-serif"],
        ["𝜕",442.93906,332.33740000000006,5.840999999999999,11,341.20340000000004,11,"sans-serif"],
        ["Γ",449.47305,332.33740000000006,6.875,11,341.20340000000004,11,"sans-serif"],
        [":",456.34805,333.21740000000005,2.75,11.077000000000002,341.20340000000004,11,"sans-serif"],
        ["𝑓",228.72629,354.89340000000004,4.9,10,362.95340000000004,10,"sans-serif"],
        ["1",233.6263,359.7814,3.983,7,365.4234,7,"sans-serif"],
        ["𝑓",356.6268,354.82340000000005,4.9,10,362.88340000000005,10,"sans-serif"],
        ["𝑛",361.5268,359.7114,4.942,7,365.3534,7,"sans-serif"],
        ["𝑓",228.72629,422.19340000000005,4.9,10,430.25340000000006,10,"sans-serif"],
        ["′",234.52629,420.98140000000006,2.849,7,426.62340000000006,7,"sans-serif"],
        ["1",233.6263,427.08140000000003,3.983,7,432.7234,7,"sans-serif"],
        ["𝑓",356.6268,422.19340000000005,4.9,10,430.25340000000006,10,"sans-serif"],
        ["′",362.4268,420.98140000000006,2.849,7,426.62340000000006,7,"sans-serif"],
        ["𝑛",361.5268,427.08140000000003,4.942,7,432.7234,7,"sans-serif"],
        ["track",237.4478,389.7234,22.53,10,397.78340000000003,10,"sans-serif"],
        ["track",301.6378,389.7234,22.53,10,397.78340000000003,10,"sans-serif"],
        ["track",365.8278,389.7234,22.53,10,397.78340000000003,10,"sans-serif"],
        ["recover",281.9178,442.25340000000006,31.440000000000005,10,450.31340000000006,10,"sans-serif"],
        ["Γ",198.2278,364.77840000000003,6.25,10,372.83840000000004,10,"sans-serif"],
        ["Γ",262.4178,364.77840000000003,6.25,10,372.83840000000004,10,"sans-serif"],
        ["Γ",326.6078,364.77840000000003,6.25,10,372.83840000000004,10,"sans-serif"],
        ["Γ",390.7978,364.77840000000003,6.25,10,372.83840000000004,10,"sans-serif"],
        ["𝜕",195.2578,414.77840000000003,5.3100000000000005,10,422.83840000000004,10,"sans-serif"],
        ["Γ",201.1978,414.77840000000003,6.25,10,422.83840000000004,10,"sans-serif"],
        ["𝜕",259.44778,414.77840000000003,5.3100000000000005,10,422.83840000000004,10,"sans-serif"],
        ["Γ",265.3878,414.77840000000003,6.25,10,422.83840000000004,10,"sans-serif"],
        ["𝜕",323.6378,414.77840000000003,5.3100000000000005,10,422.83840000000004,10,"sans-serif"],
        ["Γ",329.5778,414.77840000000003,6.25,10,422.83840000000004,10,"sans-serif"],
        ["𝜕",387.8278,414.77840000000003,5.3100000000000005,10,422.83840000000004,10,"sans-serif"],
        ["Γ",393.7678,414.77840000000003,6.25,10,422.83840000000004,10,"sans-serif"],
        ["The diagram shows that the tracked effects followed by",87.36614,466.89940000000007,260.78617488000003,11.077000000000002,474.88540000000006,11,"sans-serif"],
        ["recover",350.06332,466.0194000000001,34.583999999999996,11,474.88540000000006,11,"sans-serif"],
        ["carry the initial effect context",386.55836186,466.89940000000007,137.85108743999993,11.077000000000002,474.88540000000006,11,"sans-serif"],
        ["back to itself. Each tracking step in fact preserves the result of recovery itself, from whatever",70.86614,480.56140000000005,453.5433062050001,11.077000000000002,488.54740000000004,11,"sans-serif"],
        ["state it is taken:",70.86614,494.2234,74.76699999999998,11.077000000000002,502.2094,11,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
    graphics: [{"x":211.98181,"y":369.4234,"width":42.691956000000005,"height":0,"kind":"path"},{"x":276.1718,"y":369.4234,"width":42.691956000000005,"height":0,"kind":"path"},{"x":340.36182,"y":369.4234,"width":42.691956000000005,"height":0,"kind":"path"},{"x":213.4478,"y":419.4234,"width":39.75999999999999,"height":0,"kind":"path"},{"x":277.6378,"y":419.4234,"width":39.75999999999999,"height":0,"kind":"path"},{"x":341.8278,"y":419.4234,"width":39.75999999999999,"height":0,"kind":"path"},{"x":232.4878,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":234.40779,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":296.6778,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":298.5978,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":360.8678,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":362.78778,"y":374.4234,"width":0,"height":38.11310000000003,"kind":"path"},{"x":393.9228,"y":428.83840000000004,"width":0,"height":23.085000999999977,"kind":"path"},{"x":203.8528,"y":454.4234,"width":187.57,"height":0,"kind":"path"},{"x":201.3528,"y":429.07840000000004,"width":0,"height":22.84499999999997,"kind":"path"}] as Parameters<typeof analyzePdfPageLayout>[0]['graphics'],
};

describe('isolated mathematical labels with local PDF geometry', () => {
    it('replays actual page-eleven type, three arrow labels and U return without protecting either surrounding paragraph', async () => {
        const before = JSON.stringify(pageElevenMathGeometry), result = analyzePdfPageLayout(pageElevenMathGeometry);
        const {pdfPageSegments} = await import('@/src/features/document-translation/services/binary');
        const segments: Array<import('@/src/features/document-translation/core/document').DocumentSegment> = [];
        const registered = pdfPageSegments(result.blocks, 11, segments);
        const protectedIndexes = result.blocks.flatMap((block, index) => block.source === 'track' || block.source === 'recover' || block.source === 'recoverΓ: 𝜕Γ → 𝜕Γ' ? [index] : []);
        expect(protectedIndexes).toHaveLength(5);
        for (const index of protectedIndexes) expect(registered.blocks[index]).toMatchObject({kind: 'formula', preserveSource: true, segmentIndex: -1});
        expect(segments.some(segment => ['track', 'recover', 'recoverΓ: 𝜕Γ → 𝜕Γ'].includes(segment.source))).toBe(false);
        for (const prefix of ['Definition 6.', 'This transformation applies', 'The diagram shows']) {
            expect(result.blocks.find(block => block.source.startsWith(prefix))).toMatchObject({kind: 'text', preserveSource: false});
            expect(segments.some(segment => segment.source.startsWith(prefix))).toBe(true);
        }
        expect(JSON.stringify(pageElevenMathGeometry)).toBe(before);
    });
    it('replays actual page-ten glyphs and excludes both mathematical labels from provider segments while retaining definition and theorem prose', async () => {
        const before = JSON.stringify(pageTenMathGeometry);
        const result = analyzePdfPageLayout(pageTenMathGeometry);
        const {pdfPageSegments} = await import('@/src/features/document-translation/services/binary');
        const segments: Array<import('@/src/features/document-translation/core/document').DocumentSegment> = [];
        const registered = pdfPageSegments(result.blocks, 10, segments);
        for (const label of ['trackΓ', 'track']) {
            const index = result.blocks.findIndex(block => block.source === label);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(registered.blocks[index]).toMatchObject({kind: 'formula', preserveSource: true, segmentIndex: -1});
            expect(segments.some(segment => segment.source === label)).toBe(false);
        }
        for (const prefix of ['Definition 3.', 'This transformation', 'Theorem 4.']) {
            expect(result.blocks.find(block => block.source.startsWith(prefix))).toMatchObject({kind: 'text', preserveSource: false});
            expect(segments.some(segment => segment.source.startsWith(prefix))).toBe(true);
        }
        expect(result.preservedRegions.some(region => region.kind === 'formula' && region.source?.includes('trackΓ ='))).toBe(true);
        expect(JSON.stringify(pageTenMathGeometry)).toBe(before);
    });
    it.each(['compose: A → B', 'rename: (Γ → Γ) ↦ Δ', 'a: 0 → 1'])('preserves the pure display type signature %s without a vocabulary whitelist', signature => {
        const result = analyze([atom(signature, 210, 100, 110), atom('Ordinary sentences anchor the body font.', 70, 220, 400)]);
        expect(result.blocks.find(block => block.source === signature)).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source.startsWith('Ordinary'))).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each([
        {name: 'type in another column', nameX: 195, nameBaseline: 100, typeX: 400, typeBaseline: 100, type: 'A → B'},
        {name: 'type on another line', nameX: 195, nameBaseline: 100, typeX: 257, typeBaseline: 140, type: 'A → B'},
        {name: 'name in another column', nameX: 100, nameBaseline: 100, typeX: 257, typeBaseline: 100, type: 'A → B'},
        {name: 'name on another line', nameX: 195, nameBaseline: 60, typeX: 257, typeBaseline: 100, type: 'A → B'},
        {name: 'missing type arrow', nameX: 195, nameBaseline: 100, typeX: 257, typeBaseline: 100, type: 'A × B'},
        {name: 'arrow without domain or codomain', nameX: 195, nameBaseline: 100, typeX: 257, typeBaseline: 100, type: '→'},
    ])('does not join a split name/colon/type with $name', ({nameX, nameBaseline, typeX, typeBaseline, type}) => {
        const result = analyze([atom('compose', nameX, nameBaseline, 30), atom(':', 240, 100, 3), atom(type, typeX, typeBaseline, 50),
            atom('Ordinary sentences anchor the body font.', 70, 300, 400)],
        [230, 250].map(x => ({kind: 'path' as const, x, y: 90, width: 0, height: 30})));
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('leaves ordinary short words, headings, sentence arrows and natural-language type explanations translatable', () => {
        const result = analyze([atom('Track', 210, 100, 50, 14), atom('track', 210, 160, 25), atom('Name: English → Chinese', 210, 210, 110),
            atom('We use track: A → B in the proof.', 70, 250, 400), atom('compose: A → B is C', 210, 290, 110), atom('compose: Γ → Γ σε Δ', 210, 330, 110),
            atom('compose: A × B', 210, 370, 100), atom('Ordinary sentences anchor the body font.', 70, 450, 400)]);
        expect(result.blocks.find(block => block.source === 'Track')).toMatchObject({kind: 'heading', preserveSource: false});
        expect(result.blocks.filter(block => block.source !== 'Track').every(block => block.kind === 'text' && !block.preserveSource)).toBe(true);
    });
    it.each(['vertical', 'horizontal'] as const)('retains a generic %s arrow label only between two distinct mathematical endpoints', orientation => {
        const vertical = orientation === 'vertical';
        const nodes = vertical ? [atom('Γ', 197, 100, 5), atom('Δ', 197, 170, 5)] : [atom('A', 180, 104, 5), atom('B', 250, 104, 5)];
        const label = vertical ? atom('compose', 206, 138, 35) : atom('compose', 203, 94, 35);
        const stroke = {kind: 'path' as const, x: vertical ? 200 : 190, y: vertical ? 110 : 100, width: vertical ? 0 : 50, height: vertical ? 50 : 0};
        const result = analyze([...nodes, label, atom('Ordinary sentences anchor the body font.', 70, 300, 400)], [stroke]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'formula', preserveSource: true});
    });
    it.each([
        {name: 'no mathematical nodes', nodes: [], width: 0, height: 50},
        {name: 'only the first endpoint', nodes: [atom('Γ', 197, 100, 5)], width: 0, height: 50},
        {name: 'only the last endpoint', nodes: [atom('Δ', 197, 170, 5)], width: 0, height: 50},
        {name: 'ordinary word endpoints', nodes: [atom('Start', 180, 100, 25), atom('Finish', 180, 170, 30)], width: 0, height: 50},
        {name: 'ordinary two-letter country labels', nodes: [atom('UK', 190, 100, 10), atom('US', 190, 170, 10)], width: 0, height: 50},
        {name: 'a thick rule', nodes: [atom('Γ', 197, 100, 5), atom('Δ', 197, 170, 5)], width: 4, height: 50},
        {name: 'a short tick', nodes: [atom('Γ', 197, 100, 5), atom('Δ', 197, 150, 5)], width: 0, height: 19},
        {name: 'a tall page divider', nodes: [atom('Γ', 197, 100, 5), atom('Δ', 197, 275, 5)], width: 0, height: 150},
    ])('does not protect a word next to $name', ({nodes, width, height}) => {
        const result = analyze([...nodes, atom('compose', 206, 138, 35), atom('Ordinary sentences anchor the body font.', 70, 400, 400)], [{kind: 'path', x: 200, y: 110, width, height}]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('cannot reuse a single central mathematical node as both arrow endpoints', () => {
        const result = analyze([atom('Γ', 194, 114, 5), atom('compose', 205, 114, 35), atom('Ordinary sentences anchor the body font.', 70, 300, 400)],
            [{kind: 'path', x: 200, y: 100, width: 0, height: 22}]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('keeps header and footer type-like text classified as page furniture, and rejects large diagram headings or remote labels', () => {
        const result = analyze([atom('rename: A → B', 210, 20, 110), atom('rename: A → B', 210, 780, 110),
            atom('Γ', 197, 100, 5), atom('Δ', 197, 170, 5), atom('Heading', 206, 138, 60, 14), atom('remote', 320, 138, 30),
            atom('Ordinary sentences anchor the body font.', 70, 400, 400)], [{kind: 'path', x: 200, y: 110, width: 0, height: 50}]);
        expect(result.blocks.filter(block => block.source === 'rename: A → B').map(block => block.kind)).toEqual(['footer', 'footer']);
        expect(result.blocks.find(block => block.source === 'Heading')).toMatchObject({kind: 'heading', preserveSource: false});
        expect(result.blocks.find(block => block.source === 'remote')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each(['vertical', 'horizontal'] as const)('recognizes a %s connector joining interiors of two independently math-supported edges', orientation => {
        const vertical = orientation === 'vertical';
        const nodes = vertical ? [atom('Γ', 160, 104, 5), atom('Δ', 235, 104, 5), atom('Θ', 160, 174, 5), atom('Λ', 235, 174, 5)]
            : [atom('Γ', 187, 89, 5), atom('Δ', 187, 169, 5), atom('Θ', 257, 89, 5), atom('Λ', 257, 169, 5)];
        const label = vertical ? atom('compose', 206, 140, 35) : atom('compose', 211, 118, 35);
        const edges = vertical ? [100, 170].map(y => ({kind: 'path' as const, x: 175, y, width: 50, height: 0}))
            : [190, 260].map(x => ({kind: 'path' as const, x, y: 100, width: 0, height: 50}));
        const connector = {kind: 'path' as const, x: 200, y: vertical ? 110 : 125, width: vertical ? 0 : 50, height: vertical ? 50 : 0};
        const result = analyze([...nodes, label, atom('Ordinary prose still translates.', 70, 400, 400)], [...edges, connector]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source.startsWith('Ordinary'))).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('allows a direct mathematical node at one connector end and an independently supported edge at the other', () => {
        const result = analyze([atom('Γ', 197, 104, 5), atom('Θ', 160, 174, 5), atom('Λ', 235, 174, 5), atom('compose', 206, 140, 35), atom('Ordinary prose still translates.', 70, 400, 400)],
            [{kind: 'path', x: 175, y: 170, width: 50, height: 0}, {kind: 'path', x: 200, y: 110, width: 0, height: 50}]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'formula', preserveSource: true});
    });
    it.each([
        {name: 'no supporting edges', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: []},
        {name: 'only one supporting edge', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100]},
        {name: 'one mathematical endpoint per supporting edge', nodes: ['Γ', '', 'Θ', ''], edges: [100, 170]},
        {name: 'ordinary word endpoints', nodes: ['Start', 'Finish', 'Start', 'Finish'], edges: [100, 170]},
        {name: 'ordinary country endpoints', nodes: ['UK', 'US', 'UK', 'US'], edges: [100, 170]},
        {name: 'parallel supporting edges', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100, 170], parallel: true},
        {name: 'connector outside supporting edges', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100, 170], connectorX: 270},
        {name: 'connector close to a supporting edge end', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100, 170], connectorX: 180},
        {name: 'connector far from both supporting edges', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100, 170], connectorY: 117, connectorHeight: 36},
        {name: 'thick supporting edges', nodes: ['Γ', 'Δ', 'Θ', 'Λ'], edges: [100, 170], thickness: 2},
    ])('leaves an ordinary name translatable with $name', ({nodes, edges, parallel, connectorX = 200, connectorY = 110, connectorHeight = 50, thickness = 0}) => {
        const points = parallel ? [[130, 104], [260, 104], [130, 174], [260, 174]] : [[160, 104], [235, 104], [160, 174], [235, 174]];
        const glyphs = nodes.flatMap((text, index) => text ? [atom(text, points[index][0], points[index][1], text.length * 5)] : []);
        const paths = parallel ? [135, 265].map(x => ({kind: 'path' as const, x, y: 110, width: 0, height: 50}))
            : edges.map(y => ({kind: 'path' as const, x: 175, y, width: 50, height: thickness}));
        const result = analyze([...glyphs, atom('compose', connectorX + 6, 140, 35), atom('Ordinary prose still translates.', 70, 400, 400)],
            [...paths, {kind: 'path', x: connectorX, y: connectorY, width: 0, height: connectorHeight}]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each([
        {name: 'the same math edge', nodeBaseline: 110, edges: [120], glyph: 'Γ', glyphX: 160, glyphWidth: 5},
        {name: 'two math edges sharing both support nodes', nodeBaseline: 114, edges: [110, 130], glyph: 'Γ', glyphX: 160, glyphWidth: 5},
        {name: 'a direct glyph reused as edge support', nodeBaseline: 114, edges: [130], glyph: 'Γ + Δ', glyphX: 185, glyphWidth: 20},
    ])('cannot reuse $name as evidence for both connector ends', ({nodeBaseline, edges, glyph, glyphX, glyphWidth}) => {
        const result = analyze([atom(glyph, glyphX, nodeBaseline, glyphWidth), atom('Θ', 235, nodeBaseline, 5), atom('compose', 206, 123, 35), atom('Ordinary prose still translates.', 70, 400, 400)],
            [...edges.map(y => ({kind: 'path' as const, x: 175, y, width: 50, height: 0})), {kind: 'path', x: 200, y: 110, width: 0, height: 20}]);
        expect(result.blocks.find(block => block.source === 'compose')).toMatchObject({kind: 'text', preserveSource: false});
    });

    const returnArrow = (options: {signature?: string | false; typeAtoms?: PdfLayoutAtom[]; nodes?: PdfLayoutAtom[]; baseX?: number; baseWidth?: number; pageWidth?: number;
        baseKind?: 'path' | 'image'; baseThickness?: number; left?: boolean; right?: boolean; cornerShift?: number; legWidth?: number; legHeight?: number; gap?: number; labelHeight?: number} = {}) => {
        const {signature = 'recover: A → B', typeAtoms, baseX = 202, baseWidth = 136, pageWidth = 612, baseKind = 'path', baseThickness = 0,
            left = true, right: hasRight = true, cornerShift = 0, legWidth = 0, legHeight = 30, gap = 1, labelHeight = 10} = options;
        const baseY = 112 + legHeight;
        const nodes = options.nodes ?? [atom('Γ', baseX - 5, 104, 5), atom('Δ', baseX + baseWidth - 1, 104, 5)];
        const label = {...atom('recover', baseX + baseWidth / 2 - 17.5, baseY - gap - (labelHeight - 8), 35), height: labelHeight};
        const graphics: Parameters<typeof analyzePdfPageLayout>[0]['graphics'] = [
            {kind: baseKind, x: baseX, y: baseY, width: baseWidth, height: baseThickness},
            ...(left ? [{kind: 'path' as const, x: baseX - 2 + cornerShift, y: 110, width: legWidth, height: legHeight}] : []),
            ...(hasRight ? [{kind: 'path' as const, x: baseX + baseWidth + 2, y: 110, width: legWidth, height: legHeight}] : []),
        ];
        return analyze([...(typeAtoms ?? (signature ? [atom(signature, 100, 70, 110)] : [])), ...nodes, label, atom('Ordinary prose still translates.', 30, 400, 300)], graphics, pageWidth);
    };
    it('recognizes a finite U return only for a same-page confirmed type function with independent mathematical endpoints', () => {
        const result = returnArrow();
        expect(result.blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source.startsWith('Ordinary'))).toMatchObject({kind: 'text', preserveSource: false});
        expect(returnArrow({signature: false}).blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each(['no same-name label', 'a same-name label far from every base'])('does not rescan dense unrelated paths with %s', scenario => {
        let geometryReads = 0;
        const graphics = Array.from({length: 900}, (_, index) => {
            const horizontal = index < 300;
            return {kind: 'path' as const, x: 10, y: 600, width: horizontal ? 100 : 0,
                get height() {geometryReads += 1; return horizontal ? 0 : 30;}};
        });
        const name = scenario === 'no same-name label' ? 'ordinary' : 'recover';
        const result = analyze([atom('recover: A → B', 100, 70, 110), atom(name, 265, 240, 35), atom('Ordinary prose still translates.', 30, 400, 300)], graphics);
        expect(result.blocks.find(block => block.source === name)).toMatchObject({kind: 'text', preserveSource: false});
        expect(geometryReads).toBeLessThan(graphics.length * 80);
    });
    it('derives a typed base name from the complete fragmented prefix followed by an actual lowered smaller subscript', () => {
        const typeAtoms = [atom('re', 100, 70, 10), atom('cover', 110, 70, 25), atom('Γ', 135, 72.5, 4, 7), atom(':', 150, 70, 3), atom('A → B', 163, 70, 45)];
        const result = returnArrow({typeAtoms});
        expect(result.blocks.find(block => block.source === 'recoverΓ: A → B')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.some(block => block.source === 're')).toBe(false);
    });
    it.each([
        {name: 'same-size Greek suffix', font: 10, baseline: 70},
        {name: 'small Greek suffix without a lowered baseline', font: 7, baseline: 70},
        {name: 'a raised superscript', font: 7, baseline: 67.5},
        {name: 'a large suffix with a lowered baseline', font: 9, baseline: 72.5},
        {name: 'a distant lowered suffix', font: 7, baseline: 80, tallArrow: true},
    ])('does not strip $name from a confirmed type name', ({font, baseline, tallArrow}) => {
        const rhs = tallArrow ? [atom('A', 163, 70, 5), atom('→', 174, 70, 5, 20), atom('B', 184, 70, 5)] : [atom('A → B', 163, 70, 45)];
        const result = returnArrow({typeAtoms: [atom('recover', 100, 70, 35), atom('Γ', 135, baseline, 4, font), atom(':', 150, 70, 3), ...rhs]});
        expect(result.blocks.find(block => block.source === 'recoverΓ: A → B')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('does not remove a lowered small letter in the middle of a typed identifier', () => {
        const result = returnArrow({typeAtoms: [atom('re', 100, 70, 10), atom('Γ', 110, 72.5, 4, 7), atom('cover', 114, 70, 25), atom(':', 150, 70, 3), atom('A → B', 163, 70, 45)]});
        expect(result.blocks.find(block => block.source === 'reΓcover: A → B')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each([
        {name: 'a frame without any confirmed type', signature: false as const},
        {name: 'only a same-name prose mention', signature: 'We use recover when needed.'},
        {name: 'a natural-language arrow explanation', signature: 'recover: English → Chinese'},
        {name: 'an unrelated typed function', signature: 'compose: A → B'},
        {name: 'a header-only type', typeAtoms: [atom('recover: A → B', 100, 20, 110)]},
        {name: 'ordinary mathematical-looking country nodes', nodes: [atom('UK', 197, 104, 10), atom('US', 337, 104, 10)]},
        {name: 'ordinary word endpoints', nodes: [atom('Start', 197, 104, 25), atom('Finish', 337, 104, 30)]},
        {name: 'only one mathematical node', nodes: [atom('Γ', 197, 104, 5)]},
        {name: 'one shared mathematical node', baseWidth: 20, nodes: [atom('Γ + Δ', 203, 104, 20)]},
        {name: 'no left leg', left: false},
        {name: 'no right leg', right: false},
        {name: 'a disconnected corner', cornerShift: 8},
        {name: 'a thick nonorthogonal leg', legWidth: 2},
        {name: 'an excessive leg length', legHeight: 130},
        {name: 'a bitmap base', baseKind: 'image' as const},
        {name: 'a thick base', baseThickness: 2},
        {name: 'a base exceeding the font limit', baseWidth: 250},
        {name: 'a base exceeding half the page', baseX: 80, baseWidth: 200, pageWidth: 380},
        {name: 'a distant label', legHeight: 68, gap: 18},
        {name: 'a label below the base', gap: -2},
        {name: 'a label too close to the upper mathematical nodes', legHeight: 20, labelHeight: 14},
    ])('does not preserve an ordinary U-frame word with $name', ({name: _name, ...options}) => {
        expect(returnArrow(options).blocks.find(block => block.source === 'recover')).toMatchObject({kind: 'text', preserveSource: false});
    });
});

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
    it('uses the PDF.js 6 combined paint operation and ignores clip-only and empty paths', () => {
        const list = {fnArray: [ops.constructPath, ops.constructPath, ops.constructPath, ops.constructPath, ops.constructPath],
            argsArray: [[ops.fill, [new Float32Array()], new Float32Array([20, 30, 40, 50])],
                [ops.endPath, [new Float32Array()], new Float32Array([1, 1, 90, 90])],
                [ops.stroke, [null], null], null, [[], [], null]]};
        expect(extractPdfGraphicsShapes(list, ops, {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]}))
            .toEqual([{kind: 'path', x: 20, y: 30, width: 20, height: 20}]);
    });
    it('clips page edges, rejects invalid/outside/empty drawings, and handles absent operands', () => {
        const list = {fnArray: [ops.transform, ops.paintImageXObject, ops.restore, ops.transform, ops.paintImageXObject, ops.restore, ops.constructPath, ops.fill, ops.constructPath, ops.stroke, ops.transform, ops.paintFormXObjectBegin, 999], argsArray: [[20, 0, 0, 20, -10, -10], [], null, [1, 0, 0, 1, 400, 400], [], null, [[], [], [NaN, 0, 1, 1]], null, [[], [], [1, 1, 1, 1]], null, null, null, null]};
        expect(extractPdfGraphicsShapes(list, ops, {width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0]})).toEqual([{kind: 'image', x: 0, y: 0, width: 10, height: 10}]);
    });
});

describe('PDF baseline and structural reading analysis', () => {
    it('keeps the narrow repeated OpenStax column gutter despite larger math spacing within the left column', () => {
        // 真实教材第50页：两栏基线不同步，栏间18pt，左栏数学项内词距约12pt。
        const atoms = ([
            ["51.", 72, 189.999, 11.875, 9.5, 181.5334, 10.5205],
            ["Consider the physical quantities", 92.779, 189.999, 126.9185, 9.5, 181.5334, 10.5205],
            ["s", 223.901, 189.999, 3.6955, 9.5, 181.5334, 10.5205],
            [",", 227.5965, 189.999, 2.375, 9.5, 181.5334, 10.5205],
            ["v, a,", 234.127, 189.999, 17.1655, 9.5, 181.5334, 10.5205],
            ["and", 255.447, 189.999, 13.7085, 9.5, 181.5334, 10.5205],
            ["t", 273.318, 189.999, 2.6315, 9.5, 181.5334, 10.5205],
            ["with", 280.111, 189.999, 16.872, 9.5, 181.5334, 10.5205],
            ["dimensions", 72, 203.99, 43.244, 9.5, 195.5244, 10.5205],
            ["[", 121.606, 203.989, 3.33, 10, 193.759, 14.66],
            ["s", 124.926, 203.989, 3.89, 10, 193.759, 13.28],
            ["] = L,", 128.806, 203.989, 24.316, 10, 193.759, 14.66],
            ["[", 164.783, 203.989, 3.33, 10, 193.759, 14.66],
            ["v", 168.103, 203.989, 4.44, 10, 193.759, 13.28],
            ["] = LT", 172.533, 203.989, 27.336, 10, 193.759, 14.66],
            ["−1", 201.116, 199.893, 9.48, 8, 191.709, 11.728],
            [",", 210.588, 203.989, 2.5, 10, 193.759, 14.66],
            ["[", 224.748, 203.989, 3.33, 10, 193.759, 14.66],
            ["a", 228.068, 203.989, 5.01, 10, 193.759, 13.28],
            ["] = LT", 233.068, 203.989, 27.336, 10, 193.759, 14.66],
            ["−2", 261.651, 199.893, 9.48, 8, 191.709, 11.728],
            [",", 271.123, 203.989, 2.5, 10, 193.759, 14.66],
            ["and", 283.283, 203.989, 13.7085, 9.5, 195.5234, 10.5205],
            ["[", 74, 218.939, 3.33, 10, 208.709, 14.66],
            ["t", 77.32, 218.939, 2.78, 10, 208.709, 13.28],
            ["] = T.", 80.27, 218.939, 24.316, 10, 208.709, 14.66],
            ["Determine", 114.23, 218.939, 40.0425, 9.5, 210.4734, 10.5205],
            ["whether", 161.9661, 218.939, 30.571, 9.5, 210.4734, 10.5205],
            ["each", 200.2068, 218.939, 17.3755, 9.5, 210.4734, 10.5205],
            ["of", 225.2504, 218.939, 7.9135, 9.5, 210.4734, 10.5205],
            ["the", 240.808, 218.939, 11.59, 9.5, 210.4734, 10.5205],
            ["following", 260.058, 218.939, 36.917, 9.5, 210.4734, 10.5205],
            ["equations is dimensionally consistent. (a)", 72, 236.48, 163.6744, 9.5, 228.0144, 10.5205],
            ["v", 241.732, 236.48, 4.44, 10, 226.25, 13.28],
            ["2", 246.829, 232.384, 4, 8, 224.2, 11.728],
            ["= 2", 253.607, 236.48, 14.618, 10, 226.25, 14.66],
            ["as", 268.225, 236.48, 8.89, 10, 226.25, 13.28],
            [";", 277.104, 236.48, 2.78, 10, 226.25, 14.66],
            ["(b)", 285.923, 236.48, 11.077, 9.5, 228.0144, 10.5205],
            ["diameter of the Moon. (c) Given that the Moon subtends", 315, 189.055, 224.981, 9.5, 180.5894, 10.5205],
            ["at an angle of about half a degree in the sky, estimate its", 315, 200.455, 224.9827, 9.5, 191.9894, 10.5205],
            ["distance from Earth.", 315, 211.855, 77.216, 9.5, 203.3894, 10.5205],
            ["63.", 315, 237.505, 11.875, 9.5, 229.0394, 10.5205],
            ["The average density of the Sun is on the order 10", 334.095, 237.505, 187.7327, 9.5, 229.0394, 10.5205],
            ["3", 521.828, 233.942, 3.5625, 7.125, 227.5928, 7.8904],
            ["kg/", 527.861, 237.505, 12.1315, 9.5, 229.0394, 10.5205]
        ] as [string, number, number, number, number, number, number][]).map(([text, x, baseline, width, fontSize, y, height]) =>
            ({...atom(text, x, baseline, width, fontSize), y, height}));
        const result = analyze(atoms);
        expect(result.blocks.find(block => block.source.includes('dimensions'))?.source).not.toContain('at an angle');
        expect(result.blocks.some(block => block.source.includes('at an angle of about half a degree'))).toBe(true);
        expect(result.blocks.every(block => block.x + block.width < 300 || block.x >= 315)).toBe(true);
    });

    it('associates OpenStax vector accents with their underlying glyph instead of inventing a separate gutter row', () => {
        // 实际 OpenStax University Physics Vol. 1 PDF 第70页第一行字形，保留原始坐标、字体指标与箭头/帽号。
        const atoms = ([
            ["The", 91.75, 87.5, 14.7535, 9.5, 79.0344, 10.5205],
            ["vector", 113.8687, 87.5, 23.712, 9.5, 79.0344, 10.5205],
            ["x", 144.954, 87.5, 4.2085, 9.5, 79.0344, 10.5205],
            ["-component", 149.17, 87.5, 45.3435, 9.5, 79.0344, 10.5205],
            ["D", 207.948, 87.5, 7.22, 10, 76.95, 15.1],
            ["→", 206.673, 80.75, 9.77, 10, 70.2, 15.1],
            ["x", 220.085, 89.26, 3.552, 8, 81.076, 10.624],
            ["= −4.0", 226.431, 87.5, 28.968, 10, 77.27, 14.66],
            ["i", 258.015, 87.5, 2.78, 10, 76.95, 15.1],
            ["^", 256.5, 80.6, 5.81, 10, 70.05, 15.1],
            ["= 4.0(−", 266.189, 87.5, 32.288, 10, 77.27, 14.66],
            ["i", 301.093, 87.5, 2.78, 10, 76.95, 15.1],
            ["^", 299.578, 80.6, 5.81, 10, 70.05, 15.1],
            [")", 306.489, 87.5, 3.33, 10, 77.27, 14.66],
            ["of", 319.158, 87.5, 7.9135, 9.5, 79.0344, 10.5205],
            ["the", 334.4207, 87.5, 11.59, 9.5, 79.0344, 10.5205],
            ["displacement", 353.3758, 87.5, 50.0555, 9.5, 79.0344, 10.5205],
            ["vector", 410.8458, 87.5, 23.712, 9.5, 79.0344, 10.5205],
            ["has", 441.931, 87.5, 12.654, 9.5, 79.0344, 10.5205],
            ["the", 461.9437, 87.5, 11.59, 9.5, 79.0344, 10.5205],
            ["magnitude", 480.8988, 87.5, 40.0615, 9.5, 79.0344, 10.5205]
        ] as [string, number, number, number, number, number, number][]).map(([text, x, baseline, width, fontSize, y, height]) =>
            ({...atom(text, x, baseline, width, fontSize), y, height}));
        const lines = pdfLayoutLines(atoms);
        expect(lines).toHaveLength(1);
        expect(lines[0].text).toContain('The vector x-component');
        expect(lines[0].text).toContain('of the displacement vector has the magnitude');
        expect(lines[0].runs.filter(run => run.text === '→' || run.text === '^')).toHaveLength(3);
    });

    it('orders independent lines by their stable baseline when one font reports a different glyph ascent', () => {
        const first = {...atom('First body line', 60, 100, 200), y: 100};
        const second = atom('Second column label', 400, 108, 150, 12);
        const before = structuredClone([first, second]);
        const plain = pdfLayoutLines([first, second]);
        const corrected = pdfLayoutLines([{...first, y: 92}, second]);
        expect(plain.map(line => [line.text, line.baseline])).toEqual([['First body line', 100], ['Second column label', 108]]);
        expect(corrected.map(line => [line.text, line.baseline])).toEqual(plain.map(line => [line.text, line.baseline]));
        expect([first, second]).toEqual(before);
    });
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
        // 表格现在先读完整表头再按记录逐行读，不能把整列值排在下一列表头之前。
        expect(result.blocks.filter(block => block.kind === 'table').map(block => [block.source, block.preserveSource])).toEqual([['Model', false], ['Score', false], ['Baseline', false], ['24.9', true]]);
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
    it('retains boundary-centred table labels when nearby rule coordinates merge or end at the last table edge', () => {
        const graphics = [100, 140].map(y => ({kind: 'path' as const, x: 100, y, width: 300, height: 0}));
        graphics.push({kind: 'path', x: 100.4, y: 100, width: 0, height: 40});
        const atoms = [atom('Left', 90, 120, 20), atom('Right', 390, 120, 20),
            {...atom('Top', 220, 100, 30), y: 99.6}, atom('Bottom', 220, 140, 35), atom('Outside', 74, 180, 50)];
        const before = structuredClone(atoms);
        const blocks = analyze(atoms, graphics).blocks;
        expect(blocks.find(block => block.source === 'Left')).toMatchObject({kind: 'table', preserveSource: false, cellBounds: {x: 100, width: 1}});
        expect(blocks.find(block => block.source === 'Right')).toMatchObject({kind: 'table', preserveSource: false, cellBounds: {x: 400, width: 1}});
        // 合法的小 ascent 标签可能以顶表线为基线，末行也可能恰落底表线；框仍有正高度且不越过外边界。
        expect(blocks.find(block => block.source === 'Top')).toMatchObject({kind: 'table', preserveSource: false, cellBounds: {y: 99, height: 41}});
        expect(blocks.find(block => block.source === 'Bottom')).toMatchObject({kind: 'table', preserveSource: false, cellBounds: {y: 100, height: 41}});
        expect(blocks.find(block => block.source === 'Outside')).toMatchObject({kind: 'text', preserveSource: false});
        expect(atoms).toEqual(before);
    });
    it('uses the full table extent when staggered short rules do not define a complete row boundary', () => {
        // 每条横线只覆盖相邻的一部分列；它们共同围出表格，不能把短线端点当作完整行界。
        const graphics = [0, 30, 60, 90].map((x, index) => ({kind: 'path' as const, x, y: 100 + index * 20, width: 150, height: 0}));
        const atoms = [atom('Fragmented table cell', 80, 130, 100)];
        const before = structuredClone(atoms);
        const result = analyze(atoms, graphics);
        expect(result.preservedRegions).toMatchObject([{kind: 'table', x: 0, y: 99, width: 240, height: 62}]);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({source: 'Fragmented table cell', kind: 'table', preserveSource: false,
            cellBounds: {x: 0, y: 99, width: 240, height: 62}});
        expect(atoms).toEqual(before);
    });
    it('keeps clipped top labels and final-rule baselines inside finite table cell bounds', () => {
        const graphics = [100, 140].map(y => ({kind: 'path' as const, x: 50, y, width: 400, height: 0}));
        // 裁剪后的文字层保留原基线，字形矩形的上沿和高度由可见部分决定。
        const atoms = [{...atom('Boundary header', 60, 100, 90), y: 97, height: 8}, atom('Boundary result', 300, 140, 90)];
        const before = structuredClone(atoms);
        const blocks = analyze(atoms, graphics).blocks;
        expect(blocks).toHaveLength(2);
        expect(blocks.find(block => block.source === 'Boundary header')).toMatchObject({kind: 'table', preserveSource: false,
            cellBounds: {x: 50, y: 99, width: 400, height: 41}});
        expect(blocks.find(block => block.source === 'Boundary result')).toMatchObject({kind: 'table', preserveSource: false,
            cellBounds: {x: 50, y: 100, width: 400, height: 41}});
        expect(atoms).toEqual(before);
    });
    it('keeps stacked shaded notes editable when their text does not repeat a table column alignment', () => {
        const graphics = [100, 125, 150].map(y => ({kind: 'path' as const, x: 0, y, width: 508, height: 25}));
        const atoms = [100, 125, 150].flatMap((y, index) => [atom(`This note ${index} contains text for later review.`, 50, y + 16, 150, 6),
            atom(`A note ${index} remains available for human review.`, 300 + index * 35, y + 16, 140, 6)]);
        const before = structuredClone(atoms);
        const result = analyze(atoms, graphics);
        expect(result.preservedRegions.some(region => region.kind === 'table')).toBe(false);
        expect(result.blocks.length).toBeGreaterThan(0);
        expect(result.blocks.every(block => block.kind === 'text' && !block.preserveSource)).toBe(true);
        expect(result.blocks.flatMap(block => block.lines!.map(line => line.text)).sort()).toEqual(atoms.map(item => item.text).sort());
        expect(atoms).toEqual(before);
    });
    it('uses the table envelope when staggered partial rules cannot define complete row boundaries', () => {
        const graphics = [100, 120, 140].map((y, index) => ({kind: 'path' as const, x: 100 + index * 50, y, width: 200, height: 0}));
        const atoms = [atom('First category', 155, 114, 80), atom('Second category', 205, 134, 85),
            atom('Ordinary prose below the table remains editable.', 100, 180, 350)];
        const before = structuredClone({atoms, graphics});
        const result = analyze(atoms, graphics);
        expect(result.preservedRegions).toMatchObject([{kind: 'table', x: 100, y: 99, width: 300, height: 42}]);
        expect(result.blocks.filter(block => block.kind === 'table').map(block => [block.source, block.cellBounds, block.preserveSource])).toEqual([
            ['First category', {x: 100, y: 99, width: 300, height: 42}, false],
            ['Second category', {x: 100, y: 99, width: 300, height: 42}, false],
        ]);
        expect(result.blocks.find(block => block.source === atoms[2].text)).toMatchObject({kind: 'text', preserveSource: false});
        expect({atoms, graphics}).toEqual(before);
    });
    it('preserves a shaded step diagram when neighbouring rows have no repeated column alignment', () => {
        const graphics = [100, 125, 150].map(y => ({kind: 'path' as const, x: 100, y, width: 420, height: 25}));
        const atoms = [['Input', 'Parse'], ['Score', 'Verify'], ['Answer', 'Export']].flatMap((row, index) =>
            [atom(row[0], 120 + index * 40, 116 + index * 25, 35), atom(row[1], 350 + index * 40, 116 + index * 25, 35)]);
        const before = structuredClone({atoms, graphics});
        const result = analyze(atoms, graphics);
        expect(result.preservedRegions).toMatchObject([{kind: 'figure', x: 100, y: 100, width: 420, height: 75}]);
        expect(result.blocks).toHaveLength(6);
        expect(result.blocks.every(block => block.kind === 'figure-label' && block.preserveSource && !block.cellBounds)).toBe(true);
        expect({atoms, graphics}).toEqual(before);
    });
    it('keeps a final grid row inside the table when matching vertical borders end without a bottom rule', () => {
        const rules = [80, 100, 120].map(y => ({kind: 'path' as const, x: 40, y, width: 400, height: 0}));
        const verticals = [40, 240, 440].map(x => ({kind: 'path' as const, x, y: 80, width: 0, height: 60}));
        const result = analyze([atom('Product', 45, 94, 70), atom('Status', 245, 94, 65), atom('Earlier item', 45, 114, 120), atom('Initial', 245, 114, 60),
            atom('Last item', 45, 134, 90), atom('Preliminary', 245, 134, 90), atom('Notes about required products', 45, 148, 180),
            atom('This explanation below the table spans every column', 45, 162, 390)], [...rules, ...verticals]);
        expect(result.blocks.find(block => block.source === 'Last item')).toMatchObject({kind: 'table'});
        expect(result.blocks.find(block => block.source === 'Preliminary')).toMatchObject({kind: 'table'});
        expect(result.blocks.find(block => block.source.startsWith('Notes about'))).toMatchObject({kind: 'text'});
        expect(result.preservedRegions.find(region => region.kind === 'table')).toMatchObject({y: 79, height: 62});
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
            {...atom('d', 480.185, 720, 5.1855333, 9.9626), y: 713.0859556},
            {...atom('model', 485.37, 721.494, 17.4345, 6.9738), y: 716.7657636}, atom('.', 503.303, 720, 2.44, 9.9626)];
        const before = structuredClone(items), result = analyze(items);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0].source).toBe('the two embedding layers and the pre-softmax linear transformation; we multiply those weights by √dmodel.');
        expect(result.blocks[0]).toMatchObject({kind: 'text', preserveSource: false, lineCount: 2});
        const radical = result.blocks[0].lines![1].runs!.find(run => run.text === '√')!;
        expect(radical).toMatchObject({x: 471.882, y: 704.82005, width: 8.30183458, baseline: 720});
        expect(radical.y + radical.height).toBeCloseTo(723.0485556, 7);
        // 原件 Page5 的 PDF.js 字形路径最低点为 -0.96 em，真实笔画到达 y721.856096。
        expect(radical.y + radical.height).toBeGreaterThan(712.292 + 9.9626 * .96);
        const equation = analyze([atom('f(x) =', 200, 120, 40), atom('√', 243, 120, 8), atom('x', 251, 120, 5)]);
        expect(equation.blocks[0]).toMatchObject({source: 'f(x) = √x', kind: 'formula', preserveSource: true});
        expect(items).toEqual(before);
    });
    it('does not shrink an associated radical or expand an unassociated radical across a gap', () => {
        const tall = {...atom('√', 471.882, 712.292, 8.30183458, 9.9626), y: 704.82005, height: 30};
        const radicand = {...atom('d', 480.185, 720, 5.1855333, 9.9626), y: 713.0859556};
        const linked = pdfLayoutLines([tall, radicand]).flatMap(line => line.runs).find(run => run.text === '√')!;
        expect(linked).toMatchObject({...tall, baseline: radicand.baseline});
        const separate = {...tall, height: 9.9626};
        const distant = {...radicand, x: 500};
        const unlinked = pdfLayoutLines([separate, distant]).flatMap(line => line.runs).find(run => run.text === '√');
        expect(unlinked).toEqual(separate);
        const equationAtoms = [atom('f(x) =', 200, 120, 40), atom('√', 243, 120, 8), atom('x', 251, 120, 5)];
        const equation = analyze(equationAtoms);
        expect(equation.blocks[0]).toMatchObject({source: 'f(x) = √x', kind: 'formula', preserveSource: true});
        expect(equation.blocks[0].lines![0].runs!.find(run => run.text === '√')).toEqual(equationAtoms[1]);
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
    it.each(['expanded guidance:', 'expanded guidance'])('separates a wide introduction ending in %s from the two columns beneath it', ending => {
        const introduction = 'The following contributors are recognized for the content of this';
        const result = analyze([atom(introduction, 72, 102, 437, 12), atom(ending, 72, 116, 96, 12),
            ...[132, 172, 212, 252].flatMap((baseline, index) => [
                atom(`Left contributor ${index}, Example Research`, 72, baseline, 200, 12), atom('Center', 72, baseline + 14, 32, 12),
                atom(`Right contributor ${index}, Sample Research`, 324, baseline, 210, 12), atom('Center', 324, baseline + 14, 32, 12),
            ])]);
        expect(result.blocks[0].source).toBe(`${introduction} ${ending}`);
        const columns = result.blocks.slice(1);
        expect(columns.length).toBeGreaterThanOrEqual(2);
        expect(columns.every(block => block.width <= 210 && !block.source.includes('guidance'))).toBe(true);
        expect(columns.map(block => block.source).join(' ')).toContain('Left contributor 0, Example Research Center');
        expect(columns.map(block => block.source).join(' ')).toContain('Right contributor 0, Sample Research Center');
        expect(result.blocks[0].y + result.blocks[0].height).toBeLessThan(columns[0].y);
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
    it('rejoins the actual reference 125 wrapped URL and protects the complete address before translation', () => {
        const lines = [
            '[125] I. Maier and M. Odersky, “Deprecating the Observer Pattern with Scala.React,”',
            'technical report EPFL-REPORT-176887, 2012. [Online]. Available: https://infoscience.epfl.ch/',
            'record/176887',
        ];
        const result = analyze(lines.map((text, index) => atom(text, 50, 100 + index * 12, index === 2 ? 80 : 500)));
        expect(result.blocks).toHaveLength(1);
        const source = `${lines[0]} ${lines[1]}${lines[2]}`;
        expect(result.blocks[0].source).toBe(source);
        expect(result.blocks[0].lines!.map(line => line.text)).toEqual(lines);
        const literals = findDocumentLiteralTerms(source);
        expect(literals.filter(term => term.source.startsWith('https://'))).toEqual([
            {source: 'https://infoscience.epfl.ch/record/176887', target: 'https://infoscience.epfl.ch/record/176887', caseSensitive: true},
        ]);
        const packet = protectGlossaryText(source, literals);
        expect(packet.text).not.toContain('record/176887');
        expect(packet.restore(packet.text.replace('Available:', '可用：'))).toBe(source.replace('Available:', '可用：'));
    });
    it('connects only the continued path token while retaining earlier URLs and the following prose', () => {
        const first = 'Sources https://first.test/1 and https://second.test/';
        const next = 'record/12 More prose follows here.';
        const source = first + next;
        expect(analyze([atom(first, 50, 100, 400), atom(next, 50, 112, 400)]).blocks.map(block => block.source)).toEqual([source]);
        expect(findDocumentLiteralTerms(source).filter(term => term.source.startsWith('https://')).map(term => term.source))
            .toEqual(['https://first.test/1', 'https://second.test/record/12']);
        const singleLine = 'Sources https://first.test/1 and https://second.test/record/12 More prose follows here.';
        expect(analyze([atom(singleLine, 50, 100, 500)]).blocks.map(block => block.source)).toEqual([singleLine]);
    });
    it.each(['read this chapter', 'summary/results', 'record/one', 'record 176887', 'https://second.test/record/12'])
    ('retains the paragraph separator when the next line is not a confirmed URL path: %s', next => {
        const first = 'Find more details at https://example.test/';
        expect(analyze([atom(first, 50, 100, 400), atom(next, 50, 112, 400)]).blocks.map(block => block.source))
            .toEqual([`${first} ${next}`]);
    });
    it('does not attach a URL path across separated paragraphs or columns', () => {
        const first = 'Find more details at https://example.test/';
        const next = 'record/12 More details follow here.';
        expect(analyze([atom(first, 50, 100, 400), atom(next, 50, 145, 400)]).blocks.map(block => block.source)).toEqual([first, next]);
        expect(analyze([atom(first, 40, 100, 220), atom(next, 330, 112, 220)]).blocks.map(block => block.source)).toEqual([first, next]);
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

// 公开论文 2609.35738 第16页公式(7)的 PDF.js 字形几何；保留 0.04em ascent 左花括号及脚标。
const harnessCases = ([
    ['h',199.038,261.8169564,5.74045012,9.9626,268.731,9.9626],
    ['⋆',204.778,259.7781828,4.08177276,6.9738,264.618,6.9738],
    ['t',204.778,266.3541828,3.00989148,6.9738,271.194,6.9738],
    ['=',212.125,260.76092,7.74891028,9.9626,268.731,9.9626],
    ['{',222.642,251.296496,8.02587028,9.9626,251.695,9.9626],
    ['h',230.667,255.0229564,5.74045012,9.9626,261.937,9.9626],
    ['′',236.407,253.09165,2.2971693,6.9738,258.322,6.9738],
    ['t',236.407,259.5601828,3.00989148,6.9738,264.4,6.9738],
    [',',239.915,255.0229564,2.76761028,9.9626,261.937,9.9626],
    ['h',230.667,269.3689564,5.74045012,9.9626,276.283,9.9626],
    ['⋆',236.407,267.8281828,4.08177276,6.9738,272.668,6.9738],
    ['t',236.407,273.9161828,3.00989148,6.9738,278.756,6.9738],
    ['−',239.41689148,273.52565,6.2269059,6.9738,278.756,6.9738],
    ['1',245.64379738,273.9510518,3.97088172,6.9738,278.756,6.9738],
    [',',250.113,269.3689564,2.76761028,9.9626,276.283,9.9626],
    ['if',262.84691268,253.96692,5.81218028,9.9626,261.937,9.9626],
    ['J',271.97664296,255.0229564,5.52426028,9.9626,261.937,9.9626],
    ['(',278.45731352,253.96692,3.87445514,9.9626,261.937,9.9626],
    ['h',282.33176866,255.0229564,5.74045012,9.9626,261.937,9.9626],
    ['′',288.072,253.09165,2.2971693,6.9738,258.322,6.9738],
    ['t',288.072,259.5601828,3.00989148,6.9738,264.4,6.9738],
    [';',291.58,253.96692,2.76761028,9.9626,261.937,9.9626],
    ['Q',296.01136074,255.0229564,7.87641636,9.9626,261.937,9.9626],
    ['dev',303.884,253.5170518,12.12814044,6.9738,258.322,6.9738],
    [')',316.51,253.96692,3.87445514,9.9626,261.937,9.9626],
    ['> J',323.15406028,255.0229564,16.0427704,9.9626,261.937,9.9626],
    ['(',340.15324096,253.96692,3.87445514,9.9626,261.937,9.9626],
    ['h',344.0276961,255.0229564,5.74045012,9.9626,261.937,9.9626],
    ['⋆',349.765,253.4821828,4.08177276,6.9738,258.322,6.9738],
    ['t',349.765,259.5701828,3.00989148,6.9738,264.41,6.9738],
    ['−',352.77489148,259.17965,6.2269059,6.9738,264.41,6.9738],
    ['1',359.00179738,259.6050518,3.97088172,6.9738,264.41,6.9738],
    [';',363.47,253.96692,2.76761028,9.9626,261.937,9.9626],
    ['Q',367.90136074,255.0229564,7.87641636,9.9626,261.937,9.9626],
    ['dev',375.774,253.5170518,12.12814044,6.9738,258.322,6.9738],
    [')',388.4,253.96692,3.87445514,9.9626,261.937,9.9626],
    [',',392.27445514,255.0229564,2.76761028,9.9626,261.937,9.9626],
    ['otherwise.',262.84321028,268.31292,43.8105335,9.9626,276.283,9.9626],
    ['(7)',512.845,260.76192,12.73021028,9.9626,268.732,9.9626],
] as Array<[string, number, number, number, number, number, number]>).map(([text, x, y, width, height, baseline, fontSize]) => ({text, x, y, width, height, baseline, fontSize, fontFamily: 'sans-serif'}));

describe('PDF piecewise equations with right-hand conditions', () => {
    it('preserves the actual two-branch formula including its if condition, otherwise row and low-ascent brace', () => {
        const above = atom('Ordinary prose explains the retained model and its development score.', 70, 235, 455, 9.9626);
        const below = atom('Methods share the seed harness and initial report within each comparison.', 70, 300, 455, 9.9626);
        const source = structuredClone(harnessCases);
        const result = analyze([...harnessCases, above, below], [], 595.276, 841.89);
        const region = result.preservedRegions.find(region => region.kind === 'formula')!;
        expect(region.source).toContain('if J('); expect(region.source).toContain('otherwise.'); expect(region.source).toContain('(7)');
        expect(result.blocks.filter(block => block.source !== above.text && block.source !== below.text).every(block => block.kind === 'formula' && block.preserveSource)).toBe(true);
        expect(result.blocks.filter(block => block.kind === 'text').map(block => block.source)).toEqual([above.text, below.text]);
        expect(region.y).toBeLessThanOrEqual(251.296496);
        expect(region.y + region.height).toBeGreaterThanOrEqual(280.9);
        expect(harnessCases).toEqual(source);
        const brace = result.blocks.flatMap(block => block.lines?.flatMap(line => line.runs ?? []) ?? []).find(run => run.text === '{')!;
        expect(brace).toEqual(source.find(run => run.text === '{'));
    });

    const example = (change: 'none' | 'no-brace' | 'one-value' | 'distant-brace' | 'distant-value' | 'natural-condition' | 'distant-condition' | 'no-assignment' = 'none') => {
        const seed = atom(change === 'no-assignment' ? 'f(x)' : 'f(x) =', 180, 269, 30);
        const brace = {...atom('{', change === 'distant-brace' ? 300 : 220, 251, 8), y: 250.6};
        const values = [atom('a', 230, 262, 7), ...(change === 'one-value' ? [] : [atom('b', change === 'distant-value' ? 400 : 230, 278, 7)])];
        const condition = atom(change === 'natural-condition' ? 'if the user is ready' : 'if score > limit', 260, change === 'distant-condition' ? 325 : 262, 80);
        const otherwise = atom('otherwise.', 260, 278, 50);
        return {atoms: [seed, ...(change === 'no-brace' ? [] : [brace]), ...values, condition, otherwise,
            atom('The following ordinary paragraph still needs translation.', 60, 350, 420)], condition, otherwise};
    };
    it('uses structural evidence rather than names or equation numbers to preserve a piecewise definition', () => {
        const {atoms, condition, otherwise} = example();
        const result = analyze(atoms);
        expect(result.blocks.filter(block => block.source.includes(condition.text) || block.source.includes(otherwise.text)).every(block => block.kind === 'formula' && block.preserveSource)).toBe(true);
        expect(result.blocks.find(block => block.source.startsWith('The following'))).toMatchObject({kind: 'text', preserveSource: false});
    });
    it.each(['no-brace', 'one-value', 'distant-brace', 'distant-value', 'natural-condition', 'distant-condition', 'no-assignment'] as const)
        ('does not absorb an ordinary condition without a complete piecewise structure: %s', change => {
            const {atoms, condition} = example(change);
            const result = analyze(atoms);
            expect(result.blocks.find(block => block.source.includes(condition.text))).toMatchObject({kind: 'text', preserveSource: false});
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
    it('does not treat short radical strokes as column dividers in an inline mathematical expression', () => {
        const lines = pdfLayoutLines([
            atom('The first factor is greater than or less than', 72, 552.62, 237.07, 9.5),
            atom('10 = 10', 318.43, 552.62, 32.4, 10), atom('0.5', 351.5, 548.41, 10, 8), atom('≈ 3.', 364.27, 552.62, 17.12, 10),
            atom('The idea is that', 385.74, 552.62, 58.2, 9.5), atom('10 = 10', 453.31, 552.62, 32.39, 10), atom('0.5', 486.37, 548.41, 10, 8), atom('is halfway', 500.72, 552.62, 39.26, 9.5),
        ], [{x: 314.8334, y: 546.7707, width: 1.35, height: 5.99}, {x: 449.7076, y: 546.7707, width: 1.35, height: 5.99}]);
        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe('The first factor is greater than or less than 10 = 100.5 ≈ 3. The idea is that 10 = 100.5 is halfway');
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
    it('keeps a separated bottom footnote translatable without treating the page number or next-column footer as a note', () => {
        const page = analyze([
            atom('The body paragraph uses the ordinary size of the article.', 54, 600, 240),
            atom('The next complete line establishes the main body font.', 54, 612, 240),
            atom('1 This footnote belongs to the left column of this article.', 54, 764, 240, 8),
            atom('7', 302, 780, 5, 8),
            atom('Downloaded from example.org', 318, 764, 150, 8),
        ], [{kind: 'path', x: 54, y: 748, width: 80, height: .5}]);
        expect(page.blocks.find(block => block.source.startsWith('1 This footnote'))).toMatchObject({kind: 'text', preserveSource: false});
        expect(page.blocks.filter(block => block.kind === 'footer').map(block => block.source)).toEqual(['Downloaded from example.org', '7']);
    });
    it('retains a multline bottom note and independently preserves differently sized, shifted or nonoverlapping nearby labels', () => {
        const body = [atom('This complete body paragraph establishes the ordinary text size for a long article.', 50, 100, 500),
            atom('Its second complete line has enough ordinary letters to keep the body size stable.', 50, 112, 500)];
        const rule = [{kind: 'path' as const, x: 50, y: 930, width: 24, height: .5}];
        const start = atom('A note begins below its own footnote separator and continues', 50, 954, 240, 8);
        const continuation = atom('with a second line outside the initial separator distance.', 50, 966, 240, 8);
        for (const near of [atom('Smaller adjacent annotation', 50, 978, 120, 7.3), atom('Separate right annotation', 350, 978, 120, 8)]) {
            const page = analyze([...body, start, continuation, near], rule, 800, 1000);
            expect(page.blocks.find(block => block.source.startsWith('A note begins'))).toMatchObject({kind: 'text', preserveSource: false});
            expect(page.blocks.flatMap(block => block.lines ?? []).some(line => line.runs?.some(run => run.text === near.text))).toBe(true);
        }
        const labels = analyze([...body, atom('See', 50, 954, 14, 8), atom('Tip', 66, 966, 14, 8)], rule, 800, 1000);
        expect(labels.blocks.flatMap(block => block.lines ?? []).flatMap(line => line.runs ?? []).map(run => run.text)).toEqual(expect.arrayContaining(['See', 'Tip']));
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
    it.each(['II. RELATED WORK', 'A. Data Collection'])('recognises a body-sized Roman or letter section heading %s', title => {
        const result = analyze([atom(title, 50, 200, 140),
            atom('The following paragraph keeps its own source text and ordinary body size.', 50, 230, 420),
            atom('Its next line continues as text instead of joining the section title above.', 50, 242, 420)]);
        expect(result.blocks.find(block => block.source === title)).toMatchObject({kind: 'heading', fontSize: 10, preserveSource: false});
        expect(result.blocks.find(block => block.source.startsWith('The following paragraph'))).toMatchObject({kind: 'text', lineCount: 2});
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
        const graphics = [Object.freeze({kind: 'image' as const, x: 100, y: 100, width: 300, height: 310})];
        const result = analyze(atoms, graphics);
        expect(analyze(atoms, graphics)).toEqual(result);
        expect(graphics[0].height).toBe(310);
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
        expect(result.blocks.filter(block => block.kind === 'table').map(block => [block.source, block.preserveSource])).toEqual([['Category', false], ['Symptom', false], ['PCIe bandwidth degradation', false], ['Straggler rank identified (via compute kernels)', false], ['Hidden size', false], ['2048', true], ['Sequence length', false], ['4096', true]]);
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
    it('keeps actual OpenStax learning-objective headings and sparse framed lists translatable', () => {
        const result = analyzePdfPageLayout(openstaxListCallout as Parameters<typeof analyzePdfPageLayout>[0]);
        expect(result.preservedRegions.filter(region => region.kind === 'figure')).toEqual([]);
        expect(result.blocks.find(block => block.source === '1.2 | Units and Standards')).toMatchObject({kind: 'heading', preserveSource: false});
        expect(result.blocks.find(block => block.source === 'Learning Objectives')).toMatchObject({kind: 'heading', preserveSource: false});
        for (const source of ['Describe how SI base units are defined.', 'Describe how derived units are created from base units.', 'Express quantities given in SI units using metric prefixes.']) {
            expect(result.blocks.find(block => block.source === source)).toMatchObject({kind: 'text', preserveSource: false, listMarker: '•'});
        }
    });
    it('does not absorb numbered section headings with a vertical separator into a following figure', () => {
        const result = analyze([atom('2.3 | Experimental Setup', 100, 80, 190, 14), atom('Axis', 130, 130, 20, 7),
            atom('The ordinary body below the illustration establishes the smaller body font.', 60, 400, 420)],
            [{kind: 'image', x: 100, y: 100, width: 260, height: 150}]);
        expect(result.blocks.find(block => block.source === '2.3 | Experimental Setup')).toMatchObject({kind: 'heading', preserveSource: false});
        expect(result.blocks.find(block => block.source === 'Axis')).toMatchObject({kind: 'figure-label', preserveSource: true});
        expect(result.preservedRegions[0].y).toBe(100);
    });
    it.each(['missing heading', 'one bullet', 'small heading'] as const)('keeps sparse diagrams protected when a list container lacks %s evidence', mode => {
        const fixture = structuredClone(openstaxListCallout);
        if (mode === 'missing heading') fixture.atoms = fixture.atoms.filter(atom => atom.text !== 'Learning Objectives');
        if (mode === 'one bullet') fixture.atoms = fixture.atoms.filter(atom => atom.y < 590 || atom.y > 620);
        if (mode === 'small heading') fixture.atoms.find(atom => atom.text === 'Learning Objectives')!.fontSize = 9.5;
        const result = analyzePdfPageLayout(fixture as Parameters<typeof analyzePdfPageLayout>[0]);
        expect(result.preservedRegions.some(region => region.kind === 'figure')).toBe(true);
        expect(result.blocks.find(block => block.source === '1.2 | Units and Standards')).toMatchObject({kind: 'heading', preserveSource: false});
    });
    it('reads text that is painted twice in place once, and counts CJK sentences inside figures as prose', () => {
        const doubled = pdfLayoutLines([atom('关系数据库标准语言', 190, 280, 252, 28), atom('SQL', 442, 280, 53, 28), atom('关系数据库标准语言', 190.1, 280, 252, 28), atom('SQL', 442.1, 280, 53, 28), atom('  ', 500, 280, 4, 28), atom('SQL', 600, 280, 53, 28)]);
        expect(doubled.map(line => line.text).join(' ')).toBe('关系数据库标准语言SQL SQL');
        // 同一位置但字号不同的同一个字不是重复描字（例如上标与正文字符重叠的排版）。
        expect(pdfLayoutLines([atom('x', 0, 0, 5, 10), atom('x', 0, 0, 5, 10.6)]).map(line => line.text).join('')).toBe('xx');
        const prose = analyze([atom('这是一句写在插图范围里面的完整中文说明', 60, 120, 200, 8), atom('A', 70, 200, 5, 5), atom('B', 140, 200, 5, 5), atom('C', 210, 200, 5, 5), atom('D', 280, 200, 5, 5), atom('Body text below the figure is long enough to set the page body size here.', 60, 500, 420), atom('More body text follows so that the median body font stays at ten points.', 60, 512, 420)], [{kind: 'image', x: 40, y: 100, width: 300, height: 200}]);
        expect(prose.blocks.find(block => block.source.startsWith('这是一句'))).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('recognizes overprinted paper text across font-dependent bucket boundaries and different run segmentation', () => {
        const whole = atom('Results', 450, 100, 35, 10);
        const sized = atom('Results', 450, 100, 35, 10.5);
        expect(pdfLayoutLines([whole, sized]).map(line => line.text)).toEqual(['Results']);
        expect(pdfLayoutLines([atom('Results', 450, 100, 70, 19.9), atom('Results', 450, 100, 70, 20.1)])
            .map(line => line.text)).toEqual(['Results']);
        const split = [atom('Res', 450.2, 100.1, 15), {...atom('ults', 465.2, 100.1, 20), fontFamily: 'serif'}];
        for (const values of [[whole, ...split], [...split, whole]]) {
            const before = structuredClone(values);
            expect(pdfLayoutLines(values).map(line => line.text)).toEqual(['Results']);
            expect(pdfLayoutLines(values).flatMap(line => line.runs)).toEqual([whole]);
            expect(analyze(values).blocks.map(block => block.source)).toEqual(['Results']);
            expect(values).toEqual(before);
        }
        const differentlySplit = [atom('R', 450, 100, 5), {...atom('esults', 455, 100, 30), fontFamily: 'serif'}];
        for (const values of [[...split, ...differentlySplit], [...differentlySplit, ...split]]) {
            expect(pdfLayoutLines(values).map(line => line.text)).toEqual(['Results']);
        }
        const phrase = atom('A careful result', 54, 140, 78);
        expect(pdfLayoutLines([phrase, atom('A', 54, 140, 5), atom('careful', 62, 140, 34), atom('result', 99, 140, 33)])
            .map(line => line.text)).toEqual(['A careful result']);
    });
    it('requires complete coincident text and geometry before discarding a differently segmented drawing', () => {
        const source = atom('Results', 450, 100, 35);
        // 只重叠部分文字、同起点却横向拉伸、邻近的重复短词、同框不同字符都必须保留。
        const cases = [
            [source, atom('Res', 450, 100, 15)],
            [source, atom('Results', 450, 100, 70)],
            [source, atom('Results', 487, 100, 35)],
            [source, atom('Res', 450, 100, 15), atom('ultx', 465, 100, 20)],
            [source, atom('Res', 450, 100, 15), atom('ults', 470, 100, 20)],
            [source, atom('Res', 450, 100, 15), atom('ults', 465, 100, 15)],
            [source, atom('Res', 450, 100, 15, 10.6), atom('ults', 465, 100, 20, 10.6)],
            [atom('Res', 450, 100, 15), atom('ults', 465, 100, 20), atom('R', 487, 100, 5), atom('esults', 492, 100, 30)],
            [atom('Res', 450, 100, 15), atom('ults', 465, 100, 20), atom('R', 450, 100, 5), atom('esultx', 455, 100, 30)],
            [atom('x', 54, 200, 5), atom('x', 59, 200, 5), atom('x', 64, 200, 5)],
            // 两种前缀分段在同一字形汇合，错误后缀不能因重复搜索而被当作完整重描。
            [atom('abcdef', 0, 240, 30), atom('ab', 0, 240, 10), atom('c', 10, 240, 5),
                atom('a', 0, 240, 5), atom('bc', 5, 240, 10), atom('d', 15, 240, 5), atom('ex', 20, 240, 10)],
        ];
        for (const values of cases) {
            expect(pdfLayoutLines(values).flatMap(line => line.runs)).toHaveLength(values.length);
        }
    });
    it('checks a long glyph-by-glyph overprint without recursion and preserves the entire drawing after a final mismatch', () => {
        const count = 12000;
        const whole = atom('a'.repeat(count), 0, 100, count * 2);
        const letters = Array.from({length: count}, (_, index) => atom('a', index * 2, 100, 2));
        expect(pdfLayoutLines([whole, ...letters]).flatMap(line => line.runs)).toHaveLength(1);
        const mismatch = [...letters.slice(0, -1), {...letters.at(-1)!, text: 'b'}];
        expect(pdfLayoutLines([whole, ...mismatch]).flatMap(line => line.runs)).toHaveLength(count + 1);
    });
    it('bounds duplicate lookup neighborhoods for extremely scaled PDF text matrices', () => {
        const large = atom('Results', 450000000, 100000000, 35000000, 10000000);
        expect(pdfLayoutLines([large, {...large}]).map(line => line.text)).toEqual(['Results']);
    });
    it('preserves text instead of looping over unsafe absolute grid coordinates', () => {
        for (const x of [2 ** 53, -(2 ** 53)]) {
            const far = atom('Results', x, 100, 35);
            expect(pdfLayoutLines([far, {...far}]).flatMap(line => line.runs)).toHaveLength(2);
        }
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
    it.each([
        ['中文', '正文', '中文正文'],
        ['𠀀𠀁', '𠀂𠀃', '𠀀𠀁𠀂𠀃'],
        ['汉𠀀', '正文', '汉𠀀正文'],
        ['中文', '𠀁字', '中文𠀁字'],
        ['𠀀，', '𠀁续', '𠀀，𠀁续'],
        ['中文PDF', '𠀁汉字', '中文PDF 𠀁汉字'],
        ['𠀀汉字', 'PDF正文', '𠀀汉字 PDF正文'],
        ['Alpha', 'beta', 'Alpha beta'],
    ])('uses complete Unicode boundary glyphs when joining %j and %j', (first, second, source) => {
        const atoms = [atom(first, 20, 100, 100), atom(second, 20, 114, 100)];
        const before = JSON.stringify(atoms);
        const result = analyze(atoms);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({source, kind: 'text', lineCount: 2});
        expect(result.blocks[0].lines!.map(line => line.text)).toEqual([first, second]);
        expect(JSON.stringify(atoms)).toBe(before);
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
        expect(twice.blocks.map(block => block.listMarker)).toEqual(['•', '•']);
    });
    it('retains repeated row-leading mathematical letters with an overlapping accent rather than stripping them as list markers', () => {
        const math = (baseline: number) => [atom('p', 282, baseline, 4.5, 8), atom('~', 282.22, baseline - .85, 4.5, 8),
            atom('i', 286.5, baseline + 1.3, 1.5, 5.2), atom('values approach zero.', 295, baseline, 100, 8)];
        const page = analyze([...math(100), ...math(111)]);
        expect(page.blocks.flatMap(block => block.lines ?? []).flatMap(line => line.runs ?? []).filter(run => run.text === 'p')).toHaveLength(2);
        expect(page.blocks.every(block => !block.listMarker)).toBe(true);
    });
    it('reassociates a native Word symbol-font bullet gutter with each line and keeps four separate list records', () => {
        const labels = ['Team Practitioner/Technical Engineer', 'Team Lead/Subsystem Lead', 'Project Systems Engineer', 'Chief Engineer'];
        const atoms = labels.flatMap((label, index) => [atom('\uF0B7', 90, 100 + index * 14, 4.5), atom(label, 108, 100 + index * 14, 210)]);
        const result = analyze(atoms);
        expect(result.blocks.map(block => block.source)).toEqual(labels);
        expect(result.blocks.every(block => block.kind === 'text' && block.listMarker === '•' && !block.preserveSource)).toBe(true);
        expect(result.preservedRegions).toEqual([]);
    });
    it('removes discretionary soft hyphens from complete words and joins a soft-hyphenated line without changing raw glyphs', () => {
        const first = 'This body line contains co\u00ADoperate and ends with inter\u00AD';
        const second = 'national continuation words that remain in the same paragraph.';
        const atoms = [atom(first, 54, 100, 420), atom(second, 54, 112, 420)];
        const before = JSON.stringify(atoms), page = analyze(atoms);
        expect(page.blocks[0].source).toBe('This body line contains cooperate and ends with international continuation words that remain in the same paragraph.');
        expect(page.blocks[0].lines![0].runs![0]!.text).toBe(first);
        expect(JSON.stringify(atoms)).toBe(before);
    });
    it('keeps a short textbook list question translatable between two display answers', () => {
        const page = analyze([
            atom('A longer paragraph establishes the normal text size and body language of this page.', 72, 100, 468),
            atom('•', 90, 200, 4), atom('How many hydrogen atoms span the Sun?', 102, 200, 260),
            atom('(Answer: 10 = 100 hydrogen atoms)', 102, 212, 186),
            atom('•', 90, 225, 4), atom('How many protons are there in a bacterium?', 102, 225, 170),
            atom('(Answer: 12 = 1000 protons)', 102, 237, 170),
        ]);
        expect(page.blocks.find(block => block.source.startsWith('How many protons'))).toMatchObject({kind: 'text', listMarker: '•', preserveSource: false});
        expect(page.preservedRegions.every(region => !(region.y < 225 && region.y + region.height > 225))).toBe(true);
    });
    it.each([220, 194])('stitches fragmented Word grid borders and keeps rowspan labels whole with first baseline %i', baseline => {
        const graphics = [100, 120, 300].flatMap(y => [{kind: 'path' as const, x: 50, y, width: 158, height: .5}, {kind: 'path' as const, x: 208, y, width: 521, height: .5}]);
        graphics.push({kind: 'path', x: 120, y: 200, width: 88, height: .5}, {kind: 'path', x: 208, y: 200, width: 521, height: .5},
            ...[50, 120, 208, 729].map(x => ({kind: 'path' as const, x, y: 100, width: .5, height: 200})),
            ...[127, 139, 207, 219].map(y => ({kind: 'path' as const, x: 218, y, width: 480, height: 10})));
        const result = analyze([
            atom('Area', 60, 114, 40), atom('Name', 130, 114, 40), atom('Description', 218, 114, 70),
            atom('System', 60, baseline, 45), atom('group', 60, baseline + 12, 35),
            atom('First system', 130, 175, 65), atom('First description includes a complete row of ordinary text', 218, 135, 480), atom('This continuation belongs to this same record.', 218, 147, 440),
            atom('Second system', 130, 260, 68), atom('Second description belongs to the next table record', 218, 215, 480), atom('and its continuation remains in that second record.', 218, 227, 440),
        ], graphics, 792, 612);
        expect(result.preservedRegions.filter(region => region.kind === 'table')).toEqual([expect.objectContaining({x: 50, width: 679})]);
        expect(result.blocks.every(block => block.kind === 'table')).toBe(true);
        expect(result.blocks.map(block => block.source)).toEqual(['Area', 'Name', 'Description', 'System group', 'First system',
            'First description includes a complete row of ordinary text This continuation belongs to this same record.', 'Second system',
            'Second description belongs to the next table record and its continuation remains in that second record.']);
        expect(result.blocks.find(block => block.source === 'System group')!.cellBounds).toMatchObject({x: 50, y: 120.5, height: 180});
    });
    it.each([
        [false, ['1', '2', '3']], [true, ['1', '2', '3']], [true, ['1e3', '2E-3', '3.4e+5']],
        [false, ['1 kg', '2 kg', '3 kg']], [true, ['1 kg', '2 kg', '3 kg']],
        [false, ['10 cm', '20 cm', '30 cm']], [true, ['10 cm', '20 cm', '30 cm']],
        [true, ['0.5 kg', '-2 kg', '3e2 kg']],
        [false, ['10 °C', '20 °C', '30 °C']], [true, ['10 °C', '20 °C', '30 °C']],
        [false, ['1 m/s', '2 m/s', '3 m/s']], [true, ['1 m/s', '2 m/s', '3 m/s']],
        [false, ['1kg', '2kg', '3kg']], [true, ['1kg', '2kg', '3kg']],
        [false, ['1 kg/m³', '2 kg/m³', '3 kg/m³']], [true, ['1 kg/m³', '2 kg/m³', '3 kg/m³']],
    ] as const)('keeps numerical records separate in an open table with header rule %s and values %j', (header, values) => {
        const graphics = [100, 180].map(y => ({kind: 'path' as const, x: 50, y, width: 500, height: .5}));
        if (header) graphics.push({kind: 'path', x: 50, y: 115, width: 500, height: .5});
        graphics.push(...[50, 250, 550].map(x => ({kind: 'path' as const, x, y: 100, width: .5, height: 80})));
        const result = analyze(['alpha', 'beta', 'gamma'].flatMap((name, index) => [
            atom(`${name} description`, 60, 120 + index * 15, 120), atom(values[index]!, 270, 120 + index * 15, values[index]!.length * 5),
        ]), graphics);
        expect(result.blocks.map(block => block.source)).toEqual(['alpha description', 'beta description', 'gamma description', ...values]);
        expect(result.blocks.every(block => block.kind === 'table')).toBe(true);
    });
    it.each(['SE 3.5', '1 do go'])('does not treat a wrapped label or multiword description %s as a numerical record inside a grid row', label => {
        const graphics = [100, 160, 180].map(y => ({kind: 'path' as const, x: 50, y, width: 500, height: .5}));
        graphics.push(...[50, 250, 550].map(x => ({kind: 'path' as const, x, y: 100, width: .5, height: 80})));
        const result = analyze([
            atom('This first description continues', 60, 120, 150), atom('with the same product configuration.', 60, 135, 170),
            atom(label, 270, 135, 40), atom('Configuration Management', 270, 147, 130),
            atom('The next record', 60, 170, 120), atom('2', 270, 170, 5),
        ], graphics);
        expect(result.blocks.map(block => block.source)).toEqual(['This first description continues with the same product configuration.', `${label} Configuration Management`, 'The next record', '2']);
    });
    it('retains a right-column rowspan phrase across an internal row rule in the left column', () => {
        const graphics = [100, 120, 300].map(y => ({kind: 'path' as const, x: 50, y, width: 500, height: .5}));
        graphics.push({kind: 'path', x: 50, y: 200, width: 400, height: .5},
            ...[50, 450, 550].map(x => ({kind: 'path' as const, x, y: 100, width: .5, height: 200})));
        const result = analyze([
            atom('Description', 60, 114, 100), atom('Area', 460, 114, 40),
            atom('First row words', 60, 135, 100), atom('Second row words', 60, 215, 100),
            atom('System', 460, 194, 45), atom('group', 460, 206, 35),
        ], graphics);
        expect(result.blocks.map(block => block.source)).toEqual(['Description', 'Area', 'First row words', 'System group', 'Second row words']);
        expect(result.blocks.find(block => block.source === 'System group')!.cellBounds).toMatchObject({x: 450, y: 120.5, height: 180});
    });
    it('keeps a table in the right column together after the complete left column', () => {
        const graphics = [90, 110, 155].map(y => ({kind: 'path' as const, x: 318, y, width: 240, height: .5}));
        const result = analyze([
            atom('Right table heading', 324, 104, 210), atom('Right table body has ordinary words', 324, 124, 210), atom('and continues within its own table.', 324, 136, 210),
            atom('Left column complete body first line has sufficient ordinary words', 54, 120, 240), atom('and the next complete line belongs to the same left paragraph', 54, 132, 240), atom('and this final line must still be before the right table.', 54, 144, 240),
            atom('Right column ordinary body continues below the table', 318, 200, 240), atom('and another line establishes the right column properly.', 318, 212, 240),
        ], graphics);
        const left = result.blocks.findIndex(block => block.source.startsWith('Left column'));
        const table = result.blocks.findIndex(block => block.source.startsWith('Right table heading'));
        const right = result.blocks.findIndex(block => block.source.startsWith('Right column ordinary'));
        expect(left).toBeLessThan(table); expect(table).toBeLessThan(right);
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
    it('preserves detached small words inside captions but leaves words overlapping a wrapped heading translatable', () => {
        const body = [atom('Body text sets the page size and is long enough to be a real sentence here.', 60, 300, 420), atom('More body text follows on the next line of the same body paragraph.', 60, 312, 420)];
        const caption = analyze([atom('Figure 1. Observations collected from the experiment', 60, 100, 420), atom('and shown with their corresponding measurements.', 60, 112, 420), atom('word', 300, 106, 14, 6), ...body]);
        expect(caption.blocks.find(block => block.kind === 'caption')).toMatchObject({lineCount: 2});
        expect(caption.blocks.find(block => block.source === 'word')).toMatchObject({kind: 'formula', preserveSource: true});
        const heading = analyze([atom('1. Main Results', 60, 100, 300), atom('and discussion', 60, 112, 110), atom('word', 300, 106, 14, 6), ...body]);
        expect(heading.blocks.find(block => block.kind === 'heading')).toMatchObject({source: '1. Main Results and discussion', lineCount: 2});
        expect(heading.blocks.find(block => block.source === 'word')).toMatchObject({kind: 'text', preserveSource: false});
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

// 发布回归使用实际 PDF.js 字形几何：Attention 1706.03762v7 的页4/9（SHA256 bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697），
// 2608.25512v1 的页18/38（SHA256 390775dbc9debdcf2ed1b076eed013387ca057630be3cb594617b2b742e48cf0）。原始字号、基线及矩形不变。
const releasePaperGeometry = {
    footnote: ([
        ["4",120.653,700.7881872,2.9888,5.9776,704.841,5.9776,"sans-serif"],
        ["To illustrate why the dot products get large, assume that the components of",123.862,702.5707808,263.9636428800001,8.9664,708.65,8.9664,"sans-serif"],
        ["q",390.066,702.4273184,4.11737088,8.9664,708.65,8.9664,"sans-serif"],
        ["and",396.749,702.5707808,12.688531968000003,8.9664,708.65,8.9664,"sans-serif"],
        ["k",411.682,702.4273184,4.797920640000001,8.9664,708.65,8.9664,"sans-serif"],
        ["are independent random",418.987,702.5707808,85.01492160000002,8.9664,708.65,8.9664,"sans-serif"],
        ["variables with mean",107.776,713.9207808,71.784191424,8.9664,720,8.9664,"sans-serif"],
        ["0",181.804,713.7773184,4.6078329600000005,8.9664,720,8.9664,"sans-serif"],
        ["and variance",188.654,713.9207808,45.207055545600014,8.9664,720,8.9664,"sans-serif"],
        ["1",236.099,713.7773184,4.6078329600000005,8.9664,720,8.9664,"sans-serif"],
        [". Then their dot product,",240.706,713.9207808,87.46407582719996,8.9664,720,8.9664,"sans-serif"],
        ["q",330.413,713.7773184,4.11737088,8.9664,720,8.9664,"sans-serif"],
        ["·",336.90000000000003,713.2752,2.5599072000000005,8.9664,720,8.9664,"monospace"],
        ["k",341.50800000000004,713.7773184,4.797920640000001,8.9664,720,8.9664,"sans-serif"],
        ["=",349.12800000000004,713.7773184,7.167740160000001,8.9664,720,8.9664,"sans-serif"],
        ["P",358.85600000000005,712.8984111999999,9.727647360000002,8.9664,713.275,8.9664,"monospace"],
        ["d",368.583,711.5895456000001,3.8406079999999996,5.9776,715.738,5.9776,"sans-serif"],
        ["k",372.423,713.6809778,3.7763235300000004,4.9813,717.138,4.9813,"sans-serif"],
        ["i",368.583,718.5915456,2.6636185599999997,5.9776,722.74,5.9776,"sans-serif"],
        ["=1",371.247,718.5915456,9.24316288,5.9776,722.74,5.9776,"sans-serif"],
        ["q",382.524,713.7773184,4.11737088,8.9664,720,8.9664,"sans-serif"],
        ["i",386.641,716.8475456,2.6636185599999997,5.9776,720.996,5.9776,"sans-serif"],
        ["k",389.803,713.7773184,4.797920640000001,8.9664,720,8.9664,"sans-serif"],
        ["i",394.601,716.8475456,2.6636185599999997,5.9776,720.996,5.9776,"sans-serif"],
        [", has mean",397.763,713.9207808,37.992878399999974,8.9664,720,8.9664,"sans-serif"],
        ["0",438.001,713.7773184,4.6078329600000005,8.9664,720,8.9664,"sans-serif"],
        ["and variance",444.85,713.9207808,45.207055545600014,8.9664,720,8.9664,"sans-serif"],
        ["d",492.296,713.7773184,4.774608000000001,8.9664,720,8.9664,"sans-serif"],
        ["k",497.07,716.9145456,3.9505958399999996,5.9776,721.063,5.9776,"sans-serif"],
        [".",501.643,713.9207808,2.2348752000000003,8.9664,720,8.9664,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
    header: ([
        ["N",146.127,137.57795559999997,8.004949100000001,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["d",167.17299250000002,137.57795559999997,5.1855333,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["model",172.358,141.25876359999995,17.4345,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["d",207.132,137.57795559999997,5.1855333,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["ff",212.317,141.25876359999995,4.470205800000011,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["h",236.238,137.57795559999997,5.74045012,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["d",258.47651572,137.57795559999997,5.1855333,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["k",263.658,141.14718279999997,4.235188739999999,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["d",285.456,137.57795559999997,5.1855333,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["v",290.641,141.14718279999997,3.98482932,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["P",309.843,137.57795559999997,6.3959892,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["drop",316.23900000000003,141.14718279999997,16.10180682,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["ϵ",345.588,137.57795559999997,4.04381934,9.9626,144.49199999999996,9.9626,"sans-serif"],
        ["ls",349.632,141.14718279999997,6.321749699999984,6.9738,145.98699999999997,6.9738,"sans-serif"],
        ["train",371.139,132.2833572,18.2614458,9.9626,139.038,9.9626,"sans-serif"],
        ["steps",370.307,143.66535719999996,19.9252,9.9626,150.41999999999996,9.9626,"sans-serif"],
        ["PPL",405.096,132.2833572,17.1655598,9.9626,139.038,9.9626,"sans-serif"],
        ["BLEU",436.01991039999996,132.2833572,26.0123486,9.9626,139.038,9.9626,"sans-serif"],
        ["params",473.9873789999999,132.2833572,28.7719888,9.9626,139.038,9.9626,"sans-serif"],
        ["6",494.99500000000006,141.96518279999995,3.9715790999999996,6.9738,146.80499999999995,6.9738,"sans-serif"],
        ["(dev)",403.293,143.66535719999996,20.77202100000003,9.9626,150.41999999999996,9.9626,"sans-serif"],
        ["(dev)",438.6403048,143.66535719999996,20.77202100000003,9.9626,150.41999999999996,9.9626,"sans-serif"],
        ["×",477.283,142.94804999999997,7.74891028,9.9626,150.41999999999996,9.9626,"sans-serif"],
        ["10",485.03200000000004,143.50595559999996,9.9626,9.9626,150.41999999999996,9.9626,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
    cases: ([
        ["notify",183.34407,456.62780000000004,28.127,11,465.4938,11,"sans-serif"],
        ["𝑑",211.47107,462.00460000000004,4.5815,7.7,468.21080000000006,7.7,"sans-serif"],
        ["(",216.73016,456.62780000000004,4.279,11,465.4938,11,"sans-serif"],
        ["𝜎",221.00917,456.62780000000004,6.281,11,465.4938,11,"sans-serif"],
        [",",227.55417,456.62780000000004,3.058,11,465.4938,11,"sans-serif"],
        ["𝜎",232.4455,456.62780000000004,6.281,11,465.4938,11,"sans-serif"],
        ["′",238.9905,455.2946,3.1339,7.7,461.5008,7.7,"sans-serif"],
        [")",242.7404,456.62780000000004,4.279,11,465.4938,11,"sans-serif"],
        ["≔",250.07495,456.62780000000004,9.966,11,465.4938,11,"sans-serif"],
        ["{",263.09653,474.37520000000006,9.921999999999999,11,483.24120000000005,11,"sans-serif"],
        ["",263.09653,468.24050000000005,9.921999999999999,11,477.10650000000004,11,"sans-serif"],
        ["",263.09653,462.12780000000004,9.921999999999999,11,470.9938,11,"sans-serif"],
        ["",263.09653,447.7430990000001,9.921999999999999,11,456.60909900000007,11,"sans-serif"],
        ["",263.09653,441.63040000000007,9.921999999999999,11,450.49640000000005,11,"sans-serif"],
        ["activating",273.01852,443.47180000000003,47.982,11,452.3378,11,"sans-serif"],
        ["if",335.65253,443.47180000000003,6.4239999999999995,11,452.3378,11,"sans-serif"],
        ["𝜎",345.72852,443.47180000000003,6.281,11,452.3378,11,"sans-serif"],
        ["⊭",355.32907,443.47180000000003,8.052,11,452.3378,11,"sans-serif"],
        ["𝑑",366.4366,443.47180000000003,5.72,11,452.3378,11,"sans-serif"],
        ["∧",374.86508,443.47180000000003,7.337,11,452.3378,11,"sans-serif"],
        ["𝜎",384.6465,443.47180000000003,6.281,11,452.3378,11,"sans-serif"],
        ["′",391.1915,442.9526,3.1339,7.7,449.15880000000004,7.7,"sans-serif"],
        ["⊧",397.99698,443.47180000000003,4.895,11,452.3378,11,"sans-serif"],
        ["𝑑",405.9475,443.47180000000003,5.72,11,452.3378,11,"sans-serif"],
        ["deactivating",273.01852,456.62780000000004,58.98199999999999,11,465.4938,11,"sans-serif"],
        ["if",335.65253,456.62780000000004,6.4239999999999995,11,465.4938,11,"sans-serif"],
        ["𝜎",345.72852,456.62780000000004,6.281,11,465.4938,11,"sans-serif"],
        ["⊧",355.32907,456.62780000000004,4.895,11,465.4938,11,"sans-serif"],
        ["𝑑",363.27963,456.62780000000004,5.72,11,465.4938,11,"sans-serif"],
        ["∧",371.70807,456.62780000000004,7.337,11,465.4938,11,"sans-serif"],
        ["𝜎",381.4895,456.62780000000004,6.281,11,465.4938,11,"sans-serif"],
        ["′",388.03452,456.1086,3.1339,7.7,462.31480000000005,7.7,"sans-serif"],
        ["⊭",394.83997,456.62780000000004,8.052,11,465.4938,11,"sans-serif"],
        ["𝑑",405.9475,456.62780000000004,5.72,11,465.4938,11,"sans-serif"],
        ["neutral",273.01852,469.78380000000004,34.265,11,478.6498,11,"sans-serif"],
        ["otherwise",335.65253,469.78380000000004,45.309,11,478.6498,11,"sans-serif"],
        ["(24)",504.85144,456.62780000000004,19.558,11,465.4938,11,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
    nested: ([
        ["Lemma",70.86614,649.83522,37.278999999999996,11,657.75522,11,"sans-serif"],
        ["57",111.97553,649.83522,11,11,657.75522,11,"sans-serif"],
        [".",122.97553,649.83522,2.75,11,657.75522,11,"sans-serif"],
        ["A member of",129.555919464,649.76922,66.27977892800001,11.077000000000002,657.75522,11,"sans-serif"],
        ["ℑ",199.66609,648.88922,6.093999999999999,11,657.75522,11,"sans-serif"],
        ["𝒜︀",205.83708,647.1363600000001,7.130210000000005,7.7,653.34256,7.7,"sans-serif"],
        ["Γ",205.76009,654.5096500000001,5.4362,7.7,660.71585,7.7,"sans-serif"],
        ["(",212.96729,648.88922,4.279,11,657.75522,11,"sans-serif"],
        ["𝑛",217.24629,648.88922,6.6,11,657.75522,11,"sans-serif"],
        [")",223.84628,648.88922,4.279,11,657.75522,11,"sans-serif"],
        ["is confined to",231.955679464,649.76922,67.302778928,11.077000000000002,657.75522,11,"sans-serif"],
        ["𝑛",303.08884,648.88922,6.6,11,657.75522,11,"sans-serif"],
        [", and it lies in",309.68884,649.76922,69.28755785600003,11.077000000000002,657.75522,11,"sans-serif"],
        ["ℑ",382.8068,648.88922,6.093999999999999,11,657.75522,11,"sans-serif"],
        ["𝑑",388.97778,645.55897,4.5815,7.7,651.76517,7.7,"sans-serif"],
        ["𝑛",393.5593,649.2340200000001,4.8454999999999995,5.5,653.6670200000001,5.5,"sans-serif"],
        ["∪",398.836,645.55897,5.1359,7.7,651.76517,7.7,"sans-serif"],
        ["𝑝",403.9719,645.55897,4.5353,7.7,651.76517,7.7,"sans-serif"],
        ["𝑛",408.5072,649.2340200000001,4.8454999999999995,5.5,653.6670200000001,5.5,"sans-serif"],
        ["Γ",388.9008,654.5096500000001,5.4362,7.7,660.71585,7.7,"sans-serif"],
        ["(",418.230289464,649.76922,5.016,11.077000000000002,657.75522,11,"sans-serif"],
        ["Definition 37",423.24628,649.76922,63.978389464,11.077000000000002,657.75522,11,"sans-serif"],
        [") at the",487.22467,649.76922,37.184778928000085,11.077000000000002,657.75522,11,"sans-serif"],
        ["projection",70.86614,663.4312000000001,48.84,11.077000000000002,671.4172000000001,11,"sans-serif"],
        ["Definition 51",122.45614,663.4312000000001,62.897999999999996,11.077000000000002,671.4172000000001,11,"sans-serif"],
        ["fixes, which is the witness",188.10414,663.4312000000001,125.91700000000004,11.077000000000002,671.4172000000001,11,"sans-serif"],
        ["Definition 48",316.77115,663.4312000000001,62.897999999999996,11.077000000000002,671.4172000000001,11,"sans-serif"],
        ["requires of it.",382.41913,663.4312000000001,64.50399999999999,11.077000000000002,671.4172000000001,11,"sans-serif"],
    ] as Array<[string, number, number, number, number, number, number, string]>).map(([text, x, y, width, height, baseline, fontSize, fontFamily]) => ({text, x, y, width, height, baseline, fontSize, fontFamily})),
};

describe('PDF release corpus mathematical typography regressions', () => {
    it('separates staggered table headers and keeps a raised exponent with its physically adjacent lower row', () => {
        const lines = pdfLayoutLines(releasePaperGeometry.header);
        expect(lines.find(line => line.text.includes('train'))?.baseline).toBe(139.038);
        expect(lines.find(line => line.text.includes('N'))?.text).not.toContain('train');
        expect(lines.find(line => line.text.includes('params'))?.text).not.toContain('6');
        const scale = lines.find(line => line.text.includes('×10'))!;
        expect(scale.text).toContain('×106');
        expect(scale.baseline).toBeCloseTo(150.42, 12);
        expect(scale.runs.find(run => run.text === '6')).toEqual(releasePaperGeometry.header.find(run => run.text === '6'));
    });
    it('preserves a detached TeX summation glyph only when its downward geometry and neighbouring equation support it', () => {
        const result = analyze(releasePaperGeometry.footnote);
        expect(result.blocks.find(block => block.source === 'Pdk')).toMatchObject({kind: 'formula', preserveSource: true});
        expect(result.blocks.find(block => block.source.includes('To illustrate why'))).toMatchObject({kind: 'text', preserveSource: false, lineCount: 2});
        const ordinary = analyze(releasePaperGeometry.footnote.map(run => run.text === 'P' ? {...run, y: run.baseline - run.fontSize * 0.8} : run));
        expect(ordinary.blocks.find(block => block.source === 'Pdk')).toMatchObject({kind: 'text', preserveSource: false});
    });
    it('keeps every piece of a compound superscript in the ordinary sentence instead of creating a false column gap', () => {
        const result = analyze(releasePaperGeometry.nested, [], 595.2756, 841.8898);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toMatchObject({kind: 'text', preserveSource: false, lineCount: 2});
        expect(result.blocks[0].source).toContain('∪𝑝');
        expect(result.blocks[0].source).toContain('(Definition 37) at the projection Definition 51');
        const runs = result.blocks[0].lines!.flatMap(line => line.runs || []);
        for (const original of releasePaperGeometry.nested) expect(runs.find(run => run.text === original.text && run.x === original.x)).toEqual(original);
    });
    it('preserves all branches and the equation number of a cases definition while translating prose containing the same operator', () => {
        const prose = atom('A definition σ ≔ d is useful in this ordinary sentence.', 70.86614, 600, 453.54, 11);
        const result = analyze([...releasePaperGeometry.cases, prose], [], 595.2756, 841.8898);
        const region = result.preservedRegions.find(region => region.kind === 'formula' && region.source?.includes('notify'))!;
        expect(region).toBeDefined();
        for (const text of ['activating', 'deactivating', 'neutral', 'otherwise', '(24)']) expect(region.source).toContain(text);
        const branches = result.blocks.filter(block => block.source !== prose.text);
        expect(branches.length).toBeGreaterThan(0);
        expect(branches.every(block => block.kind === 'formula' && block.preserveSource)).toBe(true);
        expect(result.blocks.find(block => block.source === prose.text)).toMatchObject({kind: 'text', preserveSource: false});
    });
});

describe('actual OpenStax poster heading geometry', () => {
    it('keeps four tightly led, left-aligned heading lines together despite unequal widths', () => {
        // OpenStax University Physics Vol. 1，第6页 PDF.js 原始字形：字体全局框27.32pt、实际基线距20pt。
        const atoms = ([
            ["Access. The future of education.", 50, 716.5596, 143.56, 10, 706.5596, 13.66],
            ["OpenStax.org", 50, 739, 132.18, 20, 719, 27.32],
            ["Give $5 or more", 50.0859, 416.0503, 153.998, 20, 396.0503, 27.32],
            ["to OpenStax and", 50.0859, 436.0503, 160.68, 20, 416.0503, 27.32],
            ["we’ll send you a", 50.0859, 456.0503, 152.58, 20, 436.0503, 27.32],
            ["sticker!", 50.0859, 476.0503, 71.86, 20, 456.0503, 27.32],
            ["OpenStax is a nonprofit initiative,", 50.0859, 498.0498, 148.49, 10, 488.0498, 13.66],
            ["which means that that every dollar", 50.0859, 510.0498, 152.76, 10, 500.0498, 13.66],
            ["you give helps us maintain and grow", 50.0859, 522.0498, 162.99, 10, 512.0498, 13.66],
            ["our library of free textbooks.", 50.0859, 534.0498, 126.45, 10, 524.0498, 13.66],
            ["If you have a few dollars to spare,", 50.0859, 558.0498, 149.33, 10, 548.0498, 13.66],
            ["visit", 50.0859, 570.0498, 17.2, 10, 560.0498, 13.66],
            ["OpenStax.org/give", 70.0659, 570.0498, 90.36, 10, 560.0498, 13.66],
            ["to donate.", 163.2059, 570.0498, 46.48, 10, 560.0498, 13.66],
            ["We’ll send you an OpenStax sticker", 50.0859, 582.0498, 157.63, 10, 572.0498, 13.66],
            ["to thank you for your support!", 50.0859, 594.0498, 133.14, 10, 584.0498, 13.66],
        ] as [string, number, number, number, number, number, number][]).map(([text, x, baseline, width, fontSize, y, height]) => ({...atom(text, x, baseline, width, fontSize), y, height}));
        const blocks = analyze(atoms).blocks;
        expect(blocks.find(block => block.source.startsWith('Give'))?.source).toBe('Give $5 or more to OpenStax and we’ll send you a sticker!');
        expect(blocks.find(block => block.source.startsWith('OpenStax is'))?.kind).toBe('text');
        expect(blocks.filter(block => /Give|to OpenStax|we’ll send you a|sticker!/u.test(block.source))).toHaveLength(1);
    });
});

describe('actual OpenStax dimensional conversion geometry', () => {
    it('preserves stacked unit fractions as part of the equation while retaining the explanation as translatable prose', () => {
        // OpenStax University Physics Vol. 1，第31页：mile/min、1609m/1mile、1min/60s 共享等式。
        const atoms = ([
            ["0.50", 200.532, 81.58, 21.167, 10, 71.35, 14.66],
            ["mile", 221.699, 76.93, 17.78, 10, 66.7, 14.66],
            ["min", 222.799, 88.475, 20.306, 10, 78.245, 14.66],
            ["×", 243.105, 81.58, 9.612, 10, 71.35, 14.66],
            ["1609 m", 252.717, 77.81, 29.78, 10, 67.58, 14.66],
            ["1 mile", 254.232, 88.475, 30.922, 10, 78.245, 14.66],
            ["×", 285.154, 81.58, 9.612, 10, 71.35, 14.66],
            ["1 min", 294.766, 77.02, 23.56, 10, 66.79, 14.66],
            ["60 s", 299.097, 87.485, 15.89, 10, 77.255, 14.66],
            ["=", 322.751, 81.58, 10.284, 10, 71.35, 14.66],
            ["(0.50)(1609)", 333.035, 76.26, 50.79, 10, 66.03, 14.66],
            ["60", 353.425, 87.485, 10, 10, 77.255, 14.66],
            ["m/s = 13 m/s.", 386.482, 81.58, 55.736, 10, 71.35, 14.66],
            ["Significance", 91.75, 107.715, 55.898, 9.5, 99.1149, 10.6133],
            ["Check the answer in the following ways:", 91.75, 123.777, 155.002, 9.5, 115.3114, 10.5205],
            ["1.", 105.827, 139.927, 7.9135, 9.5, 131.3269, 10.6133],
            ["Be sure the units in the unit conversion cancel correctly. If the unit conversion factor was written upside", 121.75, 139.927, 399.2325, 9.5, 131.4614, 10.5205],
        ] as [string, number, number, number, number, number, number][]).map(([text, x, baseline, width, fontSize, y, height]) => ({...atom(text, x, baseline, width, fontSize), y, height}));
        const graphics = [{"x": 220.6989, "y": 69.1, "width": 19.74, "height": 8.92, "kind": "path"}, {"x": 221.7989, "y": 80.645, "width": 17.54, "height": 8.83, "kind": "path"}, {"x": 220.0322, "y": 79.02, "width": 21.073, "height": 0, "kind": "path"}, {"x": 261.2328, "y": 80.645, "width": 19.74, "height": 8.92, "kind": "path"}, {"x": 252.0511, "y": 79.02, "width": 31.103, "height": 0, "kind": "path"}, {"x": 301.7667, "y": 69.19, "width": 17.54, "height": 8.83, "kind": "path"}, {"x": 294.1, "y": 79.02, "width": 25.873, "height": 0, "kind": "path"}, {"x": 332.3689, "y": 79.02, "width": 52.113, "height": 0, "kind": "path"}] as const;
        const result = analyze(atoms, [...graphics]);
        expect(result.blocks.filter(block => /mile|min/u.test(block.source)).every(block => block.preserveSource)).toBe(true);
        expect(result.preservedRegions.some(region => region.kind === 'formula' && region.source?.includes('mile') && region.source.includes('min'))).toBe(true);
        expect(result.blocks.find(block => block.source.includes('Check the answer'))?.preserveSource).toBe(false);
        expect(result.blocks.find(block => block.source.includes('Be sure the units'))?.preserveSource).toBe(false);
    });
});


it('keeps actual OpenStax p57 caption words on their prose baseline beside stretched bars', () => {
    const source: Array<[string, number, number, number, number, number, number]> = [["directions (even though",173.28000000000003,373.76998046874996,84.915,9.966796875,381.78999999999996,9],["|",262.5071,370.36434,2,17.705399999999997,387.7105,25.659999999999997],["and",264.225,392.84998046875,13.500000000000004,9.966796875,400.87,9],["→",267.2749,364.3501,9.77,15.1,381.7901,10],["A",268.5499,371.2401,7.22,15.1,381.7901,10],["| = | −",279.8127,370.36434,25.447699999999955,17.705399999999997,387.7105,25.659999999999997],["→",310.2504,364.3501,9.77,15.1,381.7901,10],["A",311.5254,371.2401,7.22,15.1,381.7901,10],["| =",322.7882,370.36434,11.617799999999967,17.705399999999997,387.7105,25.659999999999997],["A",337.674,371.5601,6.11,13.279999999999998,381.7901,10],[")",343.774,371.5601,3.33,14.66,381.7901,10],[". (d)",349.094,373.76998046875,14.994,9.966796875,381.79,9],["→",371.11600000000004,364.35,9.77,15.1,381.79,10],["A",372.391,371.24,7.22,15.1,381.79,10],["=",386.432,371.56,6.8500000000000005,14.66,381.79,10],["→",398.82800000000003,364.49,9.77,15.1,381.79,10],["B",400.37800000000004,371.24,6.67,15.1,381.79,10],["because they are parallel",173.28,392.84998046875,88.58699999999999,9.966796875,400.87,9],["have identical magnitudes",279.975,392.84998046875,93.86100000000002,9.966796875,400.87,9],["A",376.19300000000004,392.84998046875,5.49,9.966796875,400.87,9],["=",383.94000000000005,392.84998046875,5.067,9.966796875,400.87,9],["B.",391.2660000000001,392.84998046875,7.74,9.966796875,400.87,9],["(e)",401.26400000000007,392.84998046875,9.981000000000002,9.966796875,400.87,9],["→",178.058,399.194,9.77,15.1,416.634,10],["A",179.333,406.084,7.22,15.1,416.634,10],["≠",193.374,406.404,6.8500000000000005,14.66,416.634,10],["→",205.76999999999998,399.334,9.77,15.1,416.634,10],["B",207.32,406.084,6.67,15.1,416.634,10],["because they have different directions (are not parallel);",222.557,408.61398046875,200.8503,9.966796875,416.634,9],["here, their directions differ by",173.27999999999997,423.27698046875,107.53520400000004,9.966796875,431.297,9],["90°",285.073,421.067,14,14.66,431.297,10],["—meaning, they are orthogonal.",301.063,423.27698046875,116.63099999999999,9.966796875,431.297,9]];
    const atoms = source.map(([text, x, y, width, height, baseline, fontSize]) => ({text, x, y, width, height, baseline, fontSize, fontFamily: 'serif'}));
    const lines = pdfLayoutLines(atoms);
    expect(lines.find(line => line.text.startsWith('directions'))?.text).not.toContain('and');
    expect(lines.find(line => line.text.startsWith('because'))?.text).toContain('parallel and have identical');
});


it('keeps actual OpenStax p105 offset column baselines independent across paragraph breaks', () => {
    const lines = pdfLayoutLines(openstaxColumnAtoms.atoms);
    expect(lines.find(line => line.text.includes('the altitude on Mt. Everest'))?.text).not.toContain('three vectors');
    expect(lines.find(line => line.text.includes('A vector has zero magnitude'))?.text).not.toContain('can you correct');
    expect(lines.some(line => line.text.includes('can you correct them?'))).toBe(true);
});


it('does not attach actual OpenStax p70 next-line unit vectors to earlier stretched delimiters', () => {
    const lines = pdfLayoutLines(openstaxSymbolAtoms.atoms);
    const line = lines.find(line => line.runs.some(run => run.text === 'i' && Math.abs(run.x - 189.9258) < .1));
    expect(line?.text).toContain('of the x-component');
    expect(line?.baseline).toBeCloseTo(138.1697, 1);
});


it('uses the horizontal size of real p70 stretched bars for grouping without changing their export size', () => {
    const atoms = [{"text": "|", "x": 93.75, "y": 192.535308, "width": 2, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "→", "x": 98.5178, "y": 188.9174, "width": 9.77, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "D", "x": 99.7928, "y": 195.6674, "width": 7.22, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "+", "x": 102.804, "y": 224.66200000000006, "width": 6.8500000000000005, "height": 14.66, "baseline": 234.89200000000005, "fontSize": 10, "fontFamily": "serif"}, {"text": "y", "x": 111.9058, "y": 199.7934, "width": 3.552, "height": 10.623999999999999, "baseline": 207.9774, "fontSize": 8, "fontFamily": "serif"}, {"text": "|", "x": 115.4502, "y": 192.535308, "width": 4.767800000000008, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "=", "x": 120.218, "y": 195.9874, "width": 9.61780000000001, "height": 14.66, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "|", "x": 129.8358, "y": 192.535308, "width": 2, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "2.9", "x": 131.8258, "y": 195.9874, "width": 12.5, "height": 14.66, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "||", "x": 144.3258, "y": 192.535308, "width": 3.990000000000009, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "^", "x": 149.4169, "y": 188.7674, "width": 5.8100000000000005, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "j", "x": 150.9419, "y": 195.6674, "width": 3.33, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "|", "x": 156.328, "y": 192.535308, "width": 4.767799999999994, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "= 2.9", "x": 161.0958, "y": 195.9874, "width": 24.118000000000002, "height": 14.66, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "because the magnitude of the unit vector is", "x": 189.658, "y": 197.75142382812498, "width": 163.2451024999999, "height": 10.5205078125, "baseline": 206.21699999999998, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "|", "x": 357.3575, "y": 192.535308, "width": 2, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "^", "x": 360.45860000000005, "y": 188.7674, "width": 5.8100000000000005, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "j", "x": 361.9836, "y": 195.6674, "width": 3.33, "height": 15.1, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": "|", "x": 367.3697, "y": 192.535308, "width": 4.767799999999966, "height": 22.212480000000003, "baseline": 214.2971, "fontSize": 32.192, "fontFamily": "serif", "layoutFontSize": 10}, {"text": "= 1", "x": 372.1375, "y": 195.9874, "width": 14.617999999999974, "height": 14.66, "baseline": 206.2174, "fontSize": 10, "fontFamily": "serif"}, {"text": ". The direction of the", "x": 388.755, "y": 197.75142382812498, "width": 80.19198899999996, "height": 10.5205078125, "baseline": 206.21699999999998, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "y", "x": 471.408, "y": 197.75142382812498, "width": 4.2085, "height": 10.5205078125, "baseline": 206.21699999999998, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "-component", "x": 475.624, "y": 197.75142382812498, "width": 45.343500000000006, "height": 10.5205078125, "baseline": 206.21699999999998, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "is", "x": 91.74900000000002, "y": 226.42642382812494, "width": 6.327, "height": 10.5205078125, "baseline": 234.89199999999994, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "^", "x": 111.31099999999999, "y": 217.44200000000006, "width": 5.8100000000000005, "height": 15.1, "baseline": 234.89200000000005, "fontSize": 10, "fontFamily": "serif"}, {"text": "j", "x": 112.836, "y": 224.34200000000004, "width": 3.33, "height": 15.1, "baseline": 234.89200000000005, "fontSize": 10, "fontFamily": "serif"}, {"text": ", which is parallel to the direction of the +", "x": 120.222, "y": 226.42642382812505, "width": 162.4946025, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "y", "x": 282.726, "y": 226.42642382812505, "width": 4.2085, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "-axis. Therefore, the", "x": 286.942, "y": 226.42642382812505, "width": 77.684806, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "y", "x": 367.36, "y": 226.42642382812505, "width": 4.2085, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "-component vector", "x": 371.576, "y": 226.42642382812505, "width": 71.80499950000002, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "→", "x": 450.901, "y": 217.59200000000004, "width": 9.77, "height": 15.1, "baseline": 234.89200000000005, "fontSize": 10, "fontFamily": "serif"}, {"text": "D", "x": 452.176, "y": 224.34200000000004, "width": 7.22, "height": 15.1, "baseline": 234.89200000000005, "fontSize": 10, "fontFamily": "serif"}, {"text": "y", "x": 464.289, "y": 228.46800000000005, "width": 3.552, "height": 10.623999999999999, "baseline": 236.65200000000004, "fontSize": 8, "fontFamily": "serif"}, {"text": "points up, as", "x": 472.551, "y": 226.42642382812505, "width": 48.43970199999995, "height": 10.5205078125, "baseline": 234.89200000000005, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "seen in", "x": 91.75, "y": 247.58942382812506, "width": 26.9159985, "height": 10.5205078125, "baseline": 256.05500000000006, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "Figure 2.17", "x": 121.328, "y": 247.45490234375006, "width": 50.45629549999998, "height": 10.61328125, "baseline": 256.05500000000006, "fontSize": 9.5, "fontFamily": "sans-serif"}, {"text": ". The scalar", "x": 171.797, "y": 247.58942382812506, "width": 44.569306999999995, "height": 10.5205078125, "baseline": 256.05500000000006, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "y", "x": 219.054, "y": 247.58942382812506, "width": 4.2085, "height": 10.5205078125, "baseline": 256.05500000000006, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "-component of vector", "x": 223.27, "y": 247.58942382812506, "width": 82.30989999999998, "height": 10.5205078125, "baseline": 256.05500000000006, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "→", "x": 313.03700000000003, "y": 238.75499999999994, "width": 9.77, "height": 15.1, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": "D", "x": 314.312, "y": 245.50499999999994, "width": 7.22, "height": 15.1, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": "is", "x": 330.229, "y": 247.58942382812495, "width": 6.327, "height": 10.5205078125, "baseline": 256.05499999999995, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "D", "x": 341.29, "y": 245.82499999999996, "width": 7.22, "height": 13.279999999999998, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": "y", "x": 349.351, "y": 249.63099999999994, "width": 3.552, "height": 10.623999999999999, "baseline": 257.81499999999994, "fontSize": 8, "fontFamily": "serif"}, {"text": "= + 2.9", "x": 355.673, "y": 245.82499999999996, "width": 33.402, "height": 14.66, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": ". The displacement vector", "x": 391.074, "y": 247.58942382812495, "width": 98.94060000000002, "height": 10.5205078125, "baseline": 256.05499999999995, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "→", "x": 497.471, "y": 238.75499999999994, "width": 9.77, "height": 15.1, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": "D", "x": 498.746, "y": 245.50499999999994, "width": 7.22, "height": 15.1, "baseline": 256.05499999999995, "fontSize": 10, "fontFamily": "serif"}, {"text": "is", "x": 514.664, "y": 247.58942382812495, "width": 6.327, "height": 10.5205078125, "baseline": 256.05499999999995, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "the resultant of its two", "x": 91.75, "y": 264.39742382812494, "width": 84.873, "height": 10.5205078125, "baseline": 272.86299999999994, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "vector", "x": 179.082, "y": 264.39742382812494, "width": 23.702499999999997, "height": 10.5205078125, "baseline": 272.86299999999994, "fontSize": 9.5, "fontFamily": "serif"}, {"text": "components.", "x": 205.19299999999998, "y": 264.39742382812494, "width": 48.2505, "height": 10.5205078125, "baseline": 272.86299999999994, "fontSize": 9.5, "fontFamily": "serif"}];
    const lines = pdfLayoutLines(atoms);
    const following = lines.find(line => line.runs.some(run => run.text === '+'));
    expect(following?.text).toContain('parallel to the direction');
    expect(lines.find(line => line.text.includes('because the magnitude'))?.text).not.toContain('D+');
    expect(lines.flatMap(line => line.runs).find(run => run.text === '|')?.fontSize).toBe(32.192);
});


it('does not turn a normal baseline anchor into a peer of its own stretched delimiter', () => {
    const atoms = [
        {text: 'Title', x: 10, y: 10, width: 40, height: 18, baseline: 24, fontSize: 18, fontFamily: 'serif'},
        {text: '|', x: 10, y: 43, width: 2, height: 15, baseline: 52, fontSize: 22, layoutFontSize: 10, fontFamily: 'serif'},
        {text: '2', x: 12, y: 42, width: 4, height: 8, baseline: 48, fontSize: 8, fontFamily: 'serif'},
        {text: 'x', x: 16, y: 45, width: 5, height: 10, baseline: 52, fontSize: 10, fontFamily: 'serif'},
    ];
    const lines = pdfLayoutLines(atoms);
    expect(lines.flatMap(line => line.runs).map(run => run.text)).toEqual(['Title', '|', '2', 'x']);
    expect(lines[1].baseline).toBe(52);
});


it('recognizes inline fraction units and multiletter variables from two-sided rules', () => {
    const cases = [
        {numerator: 'rMg', denominator: 'Iω', source: 'The precessional angular velocity is given by', x: 250, y: 200},
        {numerator: '1 rev', denominator: '2π rad', source: 'Number of rev = (220 rad)', x: 250, y: 200},
        {numerator: 'GmME', denominator: 'r', source: 'Esurface = Ksurface + Usurface = 0 −', x: 250, y: 200},
    ];
    for (const example of cases) {
        const source = atom(example.source, 30, example.y + 3, 215);
        const numerator = atom(example.numerator, example.x, example.y - 3, 32);
        const denominator = atom(example.denominator, example.x, example.y + 9, 32);
        const result = analyze([source, numerator, denominator], [{x: example.x - 1, y: example.y, width: 34, height: 0, kind: 'path'}]);
        expect(result.blocks.some(block => block.source.includes(example.denominator) && block.preserveSource)).toBe(true);
        expect(result.preservedRegions.some(region => region.kind === 'formula')).toBe(true);
    }
});


it.each([['energy', openstaxEnergyTable], ['density', openstaxDensityTable]])('recognizes actual OpenStax %s tables without a closing border', (_name, fixture) => {
    const result = analyzePdfPageLayout(fixture.input as Parameters<typeof analyzePdfPageLayout>[0]);
    expect(result.preservedRegions.some(region => region.kind === 'table')).toBe(true);
    const cells = result.blocks.filter(block => block.kind === 'table');
    expect(cells.some(block => block.source === 'Big Bang' || block.source === 'Concrete')).toBe(true);
    expect(cells.filter(block => !block.preserveSource).length).toBeGreaterThan(3);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        expect(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 2
            || Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 2).toBe(true);
    }
});


it('keeps a real p908 wide formula separate from the adjacent column across a reduced gutter', () => {
    const lines = pdfLayoutLines(openstaxNarrowFormulaColumns.atoms);
    expect(lines.find(line => line.text.includes('4.50 nm'))?.text).not.toContain('shriek');
    expect(lines.find(line => line.text.includes('shriek'))?.x).toBe(315);
});


it.each(openstaxInlineFractions.cases)('keeps multi-fraction pieces on actual p$page out of overlapping translation blocks', ({input}) => {
    const result = analyzePdfPageLayout(input as Parameters<typeof analyzePdfPageLayout>[0]);
    const translated = result.blocks.filter(block => !block.preserveSource);
    expect(translated.length).toBeGreaterThan(0);
    for (let i = 0; i < translated.length; i++) for (let j = i + 1; j < translated.length; j++) {
        const a = translated[i], b = translated[j];
        const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(w <= 2 || h <= 2 || w * h <= .2 * Math.min(a.width * a.height, b.width * b.height), a.source + ' / ' + b.source).toBe(true);
    }
});


it('keeps the actual p693 long subscript attached to its single-letter base', () => {
    const lines = pdfLayoutLines([{"text": "relate the two radii and note that the two masses must have", "x": 72, "y": 464.62842382812505, "width": 224.98390199999992, "height": 10.5205078125, "fontFamily": "serif", "baseline": 473.09400000000005, "fontSize": 9.5}, {"text": "and", "x": 315, "y": 468.905423828125, "width": 13.7085, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "Δ", "x": 337.538, "y": 470.631, "width": 7.22, "height": 6.74, "fontFamily": "serif", "baseline": 477.371, "fontSize": 10}, {"text": "v", "x": 344.748, "y": 472.96099999999996, "width": 4.44, "height": 4.59, "fontFamily": "serif", "baseline": 477.371, "fontSize": 10}, {"text": "EllipseMars", "x": 349.84499999999997, "y": 475.185, "width": 38.664, "height": 7.2, "fontFamily": "serif", "baseline": 480.649, "fontSize": 8}, {"text": ",", "x": 390.428, "y": 468.905423828125, "width": 2.375, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "needed", "x": 399.6241045, "y": 468.905423828125, "width": 26.875500000000002, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "for", "x": 433.3450005, "y": 468.905423828125, "width": 11.077, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "a", "x": 451.2433045, "y": 468.905423828125, "width": 4.2085, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "trip", "x": 462.28100300000006, "y": 468.905423828125, "width": 13.1765, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "to", "x": 482.2945010000001, "y": 468.905423828125, "width": 7.3815, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "Mars.", "x": 496.5051045000001, "y": 468.905423828125, "width": 21.887999999999998, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}, {"text": "Use", "x": 525.2254000000001, "y": 468.905423828125, "width": 14.763000000000002, "height": 10.5205078125, "fontFamily": "serif", "baseline": 477.371, "fontSize": 9.5}]);
    expect(lines.some(line => line.text === 'EllipseMars')).toBe(false);
    expect(lines.find(line => line.text.includes('and'))?.text).toContain('vEllipseMars');
});


it('joins actual p693 local baseline peers despite an offset formula in the other column', () => {
    const lines = pdfLayoutLines([{"text": "in", "x": 271.76, "y": 226.70699999999994, "width": 6.224, "height": 5.464, "fontFamily": "serif", "baseline": 232.17099999999994, "fontSize": 8}, {"text": "R", "x": 74.13, "y": 238.359, "width": 6.11, "height": 6.53, "fontFamily": "serif", "baseline": 244.889, "fontSize": 10}, {"text": "out", "x": 80.89699999999999, "y": 242.57300000000004, "width": 10.224, "height": 4.712, "fontFamily": "serif", "baseline": 247.20500000000004, "fontSize": 8}, {"text": ". Find", "x": 95.675, "y": 234.64242382812495, "width": 23.194097999999997, "height": 10.5205078125, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 9.5}, {"text": "g", "x": 122.28399999999999, "y": 234.64242382812495, "width": 4.75, "height": 10.5205078125, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 9.5}, {"text": "for both", "x": 130.44, "y": 234.64242382812495, "width": 31.364202499999987, "height": 10.5205078125, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 9.5}, {"text": "R", "x": 167.347, "y": 236.57799999999995, "width": 6.11, "height": 6.53, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "in", "x": 174.114, "y": 240.37599999999992, "width": 6.224, "height": 5.464, "fontFamily": "serif", "baseline": 245.83999999999992, "fontSize": 8}, {"text": "<", "x": 183.108, "y": 237.76799999999994, "width": 6.8500000000000005, "height": 5.58, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "r", "x": 192.726, "y": 238.69799999999995, "width": 3.89, "height": 4.41, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "<", "x": 199.624, "y": 237.76799999999994, "width": 6.8500000000000005, "height": 5.58, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "R", "x": 209.37199999999999, "y": 236.57799999999995, "width": 6.11, "height": 6.53, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "out", "x": 216.13899999999998, "y": 240.79199999999997, "width": 10.224, "height": 4.712, "fontFamily": "serif", "baseline": 245.42399999999998, "fontSize": 8}, {"text": "and for", "x": 231.767, "y": 234.64242382812495, "width": 28.19909700000001, "height": 10.5205078125, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 9.5}, {"text": "r", "x": 265.372, "y": 238.69799999999995, "width": 3.89, "height": 4.41, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "<", "x": 272.27000000000004, "y": 237.76799999999994, "width": 6.8500000000000005, "height": 5.58, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "R", "x": 282.01800000000003, "y": 236.57799999999995, "width": 6.11, "height": 6.53, "fontFamily": "serif", "baseline": 243.10799999999995, "fontSize": 10}, {"text": "in", "x": 288.785, "y": 240.37599999999992, "width": 6.224, "height": 5.464, "fontFamily": "serif", "baseline": 245.83999999999992, "fontSize": 8}, {"text": "(", "x": 369.306, "y": 231.56900000000007, "width": 3.33, "height": 8.53, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}, {"text": "g", "x": 372.626, "y": 233.91900000000007, "width": 5, "height": 6.470000000000001, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}, {"text": "−", "x": 379.84799999999996, "y": 235.46900000000005, "width": 6.8500000000000005, "height": 0.6600000000000004, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}, {"text": "ω", "x": 388.90999999999997, "y": 233.93900000000008, "width": 6.86, "height": 4.5, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}, {"text": "2", "x": 396.42699999999996, "y": 228.82500000000007, "width": 4, "height": 5.408, "fontFamily": "serif", "baseline": 234.23300000000006, "fontSize": 8}, {"text": "R", "x": 402.05699999999996, "y": 231.79900000000006, "width": 6.11, "height": 6.53, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}, {"text": "E", "x": 408.82399999999996, "y": 235.6810000000001, "width": 4.888, "height": 5.296, "fontFamily": "serif", "baseline": 240.9770000000001, "fontSize": 8}, {"text": ")", "x": 413.70399999999995, "y": 231.56900000000007, "width": 3.987000000000039, "height": 8.53, "fontFamily": "serif", "baseline": 238.32900000000006, "fontSize": 10}]);
    expect(lines.find(line => line.text.startsWith('Rout'))?.text).toContain('Find g');
    expect(lines.find(line => line.text.startsWith('Rout'))?.text).not.toContain('ω');
});


it('joins the real p228 proportionality operator between prose fragments', () => {
    const lines = pdfLayoutLines([{"text": "a", "x": 284.427, "y": 288.93, "width": 5, "height": 4.87, "fontFamily": "serif", "baseline": 293.66, "fontSize": 10}, {"text": "→", "x": 282.047, "y": 284.42, "width": 9.77, "height": 3.96, "fontFamily": "serif", "baseline": 288.93, "fontSize": 10}, {"text": "∝", "x": 297.363, "y": 289.36, "width": 6.8500000000000005, "height": 4.3, "fontFamily": "serif", "baseline": 293.66, "fontSize": 10}, {"text": "F", "x": 311.589, "y": 286.90000000000003, "width": 6.11, "height": 6.760000000000001, "fontFamily": "serif", "baseline": 293.66, "fontSize": 10}, {"text": "→", "x": 309.759, "y": 282.40000000000003, "width": 9.77, "height": 3.96, "fontFamily": "serif", "baseline": 286.91, "fontSize": 10}, {"text": "net", "x": 322.963, "y": 291.344, "width": 9.703999999999997, "height": 4.712, "fontFamily": "serif", "baseline": 295.976, "fontSize": 8}, {"text": "where the symbol", "x": 72, "y": 305.732423828125, "width": 71.3565995, "height": 10.5205078125, "fontFamily": "serif", "baseline": 314.198, "fontSize": 9.5}, {"text": "∝", "x": 152.444, "y": 309.89799999999997, "width": 6.8500000000000005, "height": 4.3, "fontFamily": "serif", "baseline": 314.198, "fontSize": 10}, {"text": "means “proportional to.” (Recall from", "x": 168.354, "y": 305.732423828125, "width": 152.4855925, "height": 10.5205078125, "fontFamily": "serif", "baseline": 314.198, "fontSize": 9.5}, {"text": "Forces", "x": 325.14, "y": 305.59790234375, "width": 31.1315, "height": 10.61328125, "fontFamily": "sans-serif", "baseline": 314.198, "fontSize": 9.5}, {"text": "that the net external force is the vector sum", "x": 360.586, "y": 305.732423828125, "width": 179.40441249999992, "height": 10.5205078125, "fontFamily": "serif", "baseline": 314.198, "fontSize": 9.5}, {"text": "of all external forces and is sometimes indicated as", "x": 72, "y": 323.487423828125, "width": 214.79810649999988, "height": 10.5205078125, "fontFamily": "serif", "baseline": 331.953, "fontSize": 9.5}, {"text": "∑", "x": 293.83, "y": 321.206145, "width": 12.87369, "height": 14.394870000000001, "fontFamily": "serif", "baseline": 331.953, "fontSize": 14.085}, {"text": "F", "x": 313.644, "y": 325.193, "width": 6.11, "height": 6.760000000000001, "fontFamily": "serif", "baseline": 331.953, "fontSize": 10}, {"text": "→", "x": 311.814, "y": 320.693, "width": 9.77, "height": 3.96, "fontFamily": "serif", "baseline": 325.203, "fontSize": 10}, {"text": ".", "x": 324.35200000000003, "y": 330.953, "width": 2.5, "height": 1.11, "fontFamily": "serif", "baseline": 331.953, "fontSize": 10}, {"text": ") This proportionality shows what we have said in", "x": 328.852, "y": 323.487423828125, "width": 211.13979899999993, "height": 10.5205078125, "fontFamily": "serif", "baseline": 331.953, "fontSize": 9.5}, {"text": "words—acceleration is directly proportional to net external force. Once the system of interest is chosen, identify the external", "x": 72, "y": 340.52142382812497, "width": 467.9599965000003, "height": 10.5205078125, "fontFamily": "serif", "baseline": 348.98699999999997, "fontSize": 9.5}]);
    expect(lines.find(line => line.text.startsWith('where the symbol'))?.text).toContain('∝ means');
});


it('keeps actual p995 three-column index entries separate despite offset baselines', () => {
    const lines = pdfLayoutLines([{"text": "INDEX", "x": 72, "y": 58.345078124999986, "width": 54.95400000000001, "height": 20.109375, "fontFamily": "sans-serif", "baseline": 74.63999999999999, "fontSize": 18}, {"text": "A", "x": 72, "y": 79.69671874999995, "width": 8.664, "height": 13.40625, "fontFamily": "sans-serif", "baseline": 90.55999999999995, "fontSize": 12}, {"text": "absolute pressure,", "x": 72, "y": 94.0142656249999, "width": 82.23, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 103.0669999999999, "fontSize": 10}, {"text": "698", "x": 157.049, "y": 94.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 103.0669999999999, "fontSize": 10}, {"text": ",", "x": 173.729, "y": 94.0142656249999, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 103.0669999999999, "fontSize": 10}, {"text": "731", "x": 179.29000000000002, "y": 94.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 103.0669999999999, "fontSize": 10}, {"text": "acceleration due to gravity,", "x": 72.00000000000001, "y": 106.0142656249999, "width": 118.76120000000002, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 115.0669999999999, "fontSize": 10}, {"text": "137", "x": 193.548, "y": 106.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 115.0669999999999, "fontSize": 10}, {"text": ",", "x": 210.228, "y": 106.0142656249999, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 115.0669999999999, "fontSize": 10}, {"text": "146", "x": 72, "y": 118.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 127.0669999999999, "fontSize": 10}, {"text": "acceleration vector,", "x": 72, "y": 130.0142656249999, "width": 86.14890000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 139.0669999999999, "fontSize": 10}, {"text": "166", "x": 160.936, "y": 130.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 139.0669999999999, "fontSize": 10}, {"text": ",", "x": 177.616, "y": 130.0142656249999, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 139.0669999999999, "fontSize": 10}, {"text": "195", "x": 183.17700000000002, "y": 130.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 139.0669999999999, "fontSize": 10}, {"text": "accuracy,", "x": 72.00000000000001, "y": 142.0142656249999, "width": 42.04250000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 151.0669999999999, "fontSize": 10}, {"text": "28", "x": 116.82900000000001, "y": 142.0142656249999, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 151.0669999999999, "fontSize": 10}, {"text": ",", "x": 127.94900000000001, "y": 142.0142656249999, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 151.0669999999999, "fontSize": 10}, {"text": "35", "x": 133.50900000000001, "y": 142.0142656249999, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 151.0669999999999, "fontSize": 10}, {"text": "action-at-a-distance force,", "x": 72.00000000000001, "y": 154.0142656249999, "width": 115.54000000000002, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 163.0669999999999, "fontSize": 10}, {"text": "667", "x": 190.389, "y": 154.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 163.0669999999999, "fontSize": 10}, {"text": ",", "x": 207.06900000000002, "y": 154.0142656249999, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 163.0669999999999, "fontSize": 10}, {"text": "675", "x": 72.00000000000001, "y": 166.0142656249999, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 175.0669999999999, "fontSize": 10}, {"text": "bow wake,", "x": 234.00099999999998, "y": 79.61426562499992, "width": 47.22000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "892", "x": 284.025, "y": 79.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": ",", "x": 300.705, "y": 79.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "893", "x": 306.26599999999996, "y": 79.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "Brahe,", "x": 233.99999999999994, "y": 91.61426562499992, "width": 29.44, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 100.66699999999992, "fontSize": 10}, {"text": "630", "x": 266.24099999999993, "y": 91.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 100.66699999999992, "fontSize": 10}, {"text": "breaking stress (ultimate", "x": 233.99999999999994, "y": 103.61426562499992, "width": 108.86999999999996, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 112.66699999999992, "fontSize": 10}, {"text": "stress),", "x": 233.99999999999994, "y": 115.61426562499992, "width": 32.760000000000005, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 124.66699999999992, "fontSize": 10}, {"text": "616", "x": 269.55699999999996, "y": 115.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 124.66699999999992, "fontSize": 10}, {"text": "Brownian motion,", "x": 233.99999999999994, "y": 127.61426562499992, "width": 77.20999999999998, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": "161", "x": 314.03899999999993, "y": 127.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": "bulk modulus,", "x": 233.99999999999994, "y": 139.61426562499992, "width": 61.67000000000002, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "604", "x": 298.47799999999995, "y": 139.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": ",", "x": 315.15799999999996, "y": 139.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "616", "x": 320.71899999999994, "y": 139.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": ",", "x": 337.39899999999994, "y": 139.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "860", "x": 342.9599999999999, "y": 139.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "bulk strain,", "x": 233.99999999999994, "y": 151.61426562499992, "width": 48.32000000000002, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "603", "x": 285.1329999999999, "y": 151.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": ",", "x": 301.81299999999993, "y": 151.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "616", "x": 307.3739999999999, "y": 151.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "bulk stress,", "x": 233.99999999999991, "y": 163.61426562499992, "width": 50.54000000000002, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "603", "x": 287.3499999999999, "y": 163.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": ",", "x": 304.0299999999999, "y": 163.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "616", "x": 309.5909999999999, "y": 163.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "bungee cord,", "x": 233.9999999999999, "y": 175.61426562499992, "width": 58.349999999999994, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}, {"text": "353", "x": 295.15699999999987, "y": 175.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}, {"text": "derived units,", "x": 395.99899999999957, "y": 79.61426562499992, "width": 59.44, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "15", "x": 458.25499999999954, "y": 79.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": ",", "x": 469.37499999999955, "y": 79.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "35", "x": 474.93499999999955, "y": 79.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 88.66699999999992, "fontSize": 10}, {"text": "destructive interference,", "x": 395.99899999999957, "y": 91.61426562499992, "width": 106.64999999999999, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 100.66699999999992, "fontSize": 10}, {"text": "817", "x": 505.4959999999996, "y": 91.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 100.66699999999992, "fontSize": 10}, {"text": ",", "x": 522.1759999999995, "y": 91.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 100.66699999999992, "fontSize": 10}, {"text": "832", "x": 395.99899999999957, "y": 103.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 112.66699999999992, "fontSize": 10}, {"text": "deuteron", "x": 395.99899999999957, "y": 115.61426562499992, "width": 39.46, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 124.66699999999992, "fontSize": 10}, {"text": ",", "x": 435.4769999999996, "y": 115.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 124.66699999999992, "fontSize": 10}, {"text": "425", "x": 441.0339999999996, "y": 115.61426562499992, "width": 16.68, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 124.66699999999992, "fontSize": 10}, {"text": "difference of two vectors,", "x": 395.9999999999996, "y": 127.61426562499992, "width": 110.90089999999995, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": "50", "x": 509.7599999999996, "y": 127.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": ",", "x": 520.8799999999995, "y": 127.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": "91", "x": 526.4399999999996, "y": 127.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 136.66699999999992, "fontSize": 10}, {"text": "dimension,", "x": 396.00099999999964, "y": 139.61426562499992, "width": 48.34000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "22", "x": 447.1389999999996, "y": 139.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": ",", "x": 458.2589999999996, "y": 139.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "35", "x": 463.8189999999996, "y": 139.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 148.66699999999992, "fontSize": 10}, {"text": "dimensionally consistent,", "x": 396.0019999999996, "y": 151.61426562499992, "width": 111.10999999999999, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "23", "x": 509.9469999999996, "y": 151.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": ",", "x": 521.0669999999996, "y": 151.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "35", "x": 526.6269999999996, "y": 151.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 160.66699999999992, "fontSize": 10}, {"text": "dimensionless,", "x": 396.0019999999996, "y": 163.61426562499992, "width": 66.12, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "22", "x": 464.9229999999996, "y": 163.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": ",", "x": 476.0429999999996, "y": 163.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "35", "x": 481.6029999999996, "y": 163.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 172.66699999999992, "fontSize": 10}, {"text": "direction angle,", "x": 396.0019999999996, "y": 175.61426562499992, "width": 67.77999999999999, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}, {"text": "60", "x": 466.6029999999996, "y": 175.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}, {"text": ",", "x": 477.7229999999996, "y": 175.61426562499992, "width": 2.77, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}, {"text": "91", "x": 483.2829999999996, "y": 175.61426562499992, "width": 11.120000000000001, "height": 11.171875, "fontFamily": "sans-serif", "baseline": 184.66699999999992, "fontSize": 10}]);
    expect(lines.find(line => line.text.includes('acceleration due'))?.text).not.toContain('breaking stress'); expect(lines.find(line => line.text.includes('breaking stress'))?.x).toBeCloseTo(234);
});


describe('open-table and stroke evidence boundaries', () => {
    it.each([false, true])('binds a root to the nearest eligible radicand with a baseline tie-break (%s)', tied => {
        const source = [atom('√', 50, 100, 8), atom('a', tied ? 58 : 59, 108, 5), atom('b', 58, 106, 5)];
        const lines = pdfLayoutLines(source);
        expect(lines.flatMap(line => line.runs).find(run => run.text === '√')?.baseline).toBe(106);
        expect(source[0].baseline).toBe(100);
    });

    it('uses the first aligned table caption and keeps later records outside the open table', () => {
        const text = [atom('Table 1.1 Measurements', 50, 210, 150), atom('Table 1.2 Later records', 50, 290, 150),
            ...[140, 160, 180, 250].flatMap((baseline, index) => [atom(String(index + 1), 60, baseline, 10), atom('Recorded observation', 160, baseline, 140)])];
        const result = analyze(text, [{kind: 'path', x: 50, y: 100, width: 100, height: 20}, {kind: 'path', x: 150, y: 100, width: 200, height: 20},
            {kind: 'path', x: 50, y: 120, width: 300, height: 0}]);
        const table = result.preservedRegions.find(region => region.kind === 'table');
        expect(table).toBeDefined(); expect(table!.y + table!.height).toBeLessThan(202);
        expect(result.blocks.filter(block => block.y > 230).every(block => block.kind !== 'table')).toBe(true);
    });

    it('attaches the nearest short label above a figure without expanding to an earlier label', () => {
        const result = analyze([atom('Earlier label', 150, 275, 60), atom('Nearest label', 150, 285, 60), atom('Ordinary prose is outside the diagram.', 50, 500, 300)],
            [{kind: 'image', x: 100, y: 300, width: 180, height: 80}]);
        const figure = result.preservedRegions.find(region => region.kind === 'figure');
        expect(figure?.y).toBe(277);
        expect(result.blocks.find(block => block.source === 'Earlier label')?.preserveSource).toBe(false);
    });

    it('does not extend a table to a lone vertical decoration below its last horizontal rule', () => {
        const result = analyze([atom('Heading', 60, 120, 70), atom('Value', 160, 120, 40)], [
            {kind: 'path', x: 50, y: 100, width: 200, height: 0}, {kind: 'path', x: 50, y: 140, width: 200, height: 0},
            {kind: 'path', x: 50, y: 100, width: 0, height: 90},
        ]);
        const table = result.preservedRegions.find(region => region.kind === 'table');
        expect(table).toBeDefined(); expect(table!.y + table!.height).toBeLessThan(150);
    });

    it('keeps a continuation with the closest existing text thread rather than a later-created older neighbor', () => {
        const source = [atom('Alpha', 50, 100, 48, 16), atom('Beta', 98, 112, 48, 16), atom('after', 50, 124, 40, 16), atom('continued', 66, 136, 112, 16)]
            .map(run => ({...run, y: run.baseline - 10, height: 10}));
        expect(analyze(source).blocks.map(block => block.source)).toEqual(['Alpha after continued', 'Beta']);
    });

    it('keeps an isolated stretched delimiter on its own baseline without borrowing a distant text anchor', () => {
        const delimiter = {...atom('|', 50, 100, 2, 22), layoutFontSize: 10};
        const lines = pdfLayoutLines([delimiter, atom('unrelated', 300, 300, 80)]);
        expect(lines).toHaveLength(2);
        expect(lines.flatMap(line => line.runs).find(run => run.text === '|')).toMatchObject({baseline: 100, fontSize: 22});
    });

    it.each(['single header', 'missing rule', 'misaligned caption', 'only two numerical rows', 'unreadable descriptions'] as const)('does not invent an open table from %s', mode => {
        const atoms = [atom('Table 1.1 Measurements', mode === 'misaligned caption' ? 400 : 50, 210, 150),
            ...[140, 160, 180].flatMap((baseline, index) => [atom(mode === 'only two numerical rows' && index === 2 ? '?' : String(index + 1), 60, baseline, 10),
                atom(mode === 'unreadable descriptions' ? 'x' : 'Recorded observation', 160, baseline, 140)])];
        const shapes = [{kind: 'path' as const, x: 50, y: 100, width: 100, height: 20},
            ...(mode === 'single header' ? [] : [{kind: 'path' as const, x: 150, y: 100, width: 200, height: 20}]),
            ...(mode === 'missing rule' ? [] : [{kind: 'path' as const, x: 50, y: 120, width: 300, height: 0}])];
        const result = analyze(atoms, shapes);
        expect(result.preservedRegions.filter(region => region.kind === 'table')).toEqual([]);
        expect(result.blocks.some(block => block.source.includes('Measurements'))).toBe(true);
    });
    it('ignores duplicate thin strokes and images while retaining distinct nearby joins and the actual root expression', () => {
        const input = structuredClone(openstaxInlineFractions.cases.find(page => page.page === 792)!.input);
        const source = {atoms: input.atoms, graphics: input.graphics, width: 612, height: 792} as Parameters<typeof analyzePdfPageLayout>[0];
        const original = analyzePdfPageLayout(source);
        const stroke = source.graphics.find(shape => shape.kind === 'path' && shape.height <= 1)!;
        const nearby = {...stroke, x: stroke.x + .01};
        const result = analyzePdfPageLayout({...source, graphics: [...source.graphics, stroke, nearby, {kind: 'image', x: 0, y: 0, width: 1, height: 1}]});
        expect(result.blocks).toEqual(original.blocks); expect(result.preservedRegions).toEqual(original.preservedRegions);
    });
});

describe('display-operator baseline ownership beside prose', () => {
    // ARGUS (arXiv:2606.20374v2), physical p7, equation3. Original SHA256:
    // 473ce13e006218d7a84f82252ac2953251d79baacead1beb77ae932f15096048.
    // PDF metadata License: http://arxiv.org/licenses/nonexclusive-distrib/1.0/.
    // Only one necessary short prose line and factual equation/glyph geometry are retained; no PDF/font copied.
    const real: PdfLayoutAtom[] = [
        {"text": "quantify distribution differences between two ranks:", "x": 317.955, "y": 547.0332174, "width": 213.3789668, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 554.017, "fontSize": 9.9626},
        {"text": "𝑊", "x": 363.55699999999996, "y": 568.0623437999999, "width": 8.5479108, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.4159999999999, "fontSize": 9.9626},
        {"text": "1", "x": 372.05499999999995, "y": 568.8128373000001, "width": 3.3818055000000005, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 573.9110000000001, "fontSize": 7.2727},
        {"text": "(", "x": 376.43299999999994, "y": 565.3724417999999, "width": 3.3175458, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.4159999999999, "fontSize": 9.9626},
        {"text": "𝐹", "x": 380.14904979999994, "y": 568.0623437999999, "width": 4.5529082, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.4159999999999, "fontSize": 9.9626},
        {"text": "𝑎", "x": 384.8109999999999, "y": 570.7473755000001, "width": 3.8908945000000004, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 573.9110000000001, "fontSize": 7.2727},
        {"text": ", 𝐹", "x": 389.1549999999999, "y": 568.0623437999999, "width": 8.508060399999973, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.4159999999999, "fontSize": 9.9626},
        {"text": "𝑏", "x": 397.62999999999994, "y": 570.8653755, "width": 3.8108948000000002, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 574.029, "fontSize": 7.2727},
        {"text": ")", "x": 402.38699999999994, "y": 565.3734418, "width": 3.3175458, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "=", "x": 408.9722785999999, "y": 565.5228808, "width": 6.3362136, "height": 9.9626, "fontFamily": "monospace", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "∫", "x": 417.63499999999993, "y": 558.3040943999999, "width": 6.176812, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 558.862, "fontSize": 9.9626},
        {"text": "∞", "x": 429.39099999999996, "y": 556.5282010999999, "width": 6.203613100000001, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 561.67, "fontSize": 7.2727},
        {"text": "0", "x": 423.31399999999996, "y": 576.1158373, "width": 3.3818055000000005, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 581.2139999999999, "fontSize": 7.2727},
        {"text": "|", "x": 438.152, "y": 565.3734418, "width": 1.99252, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝐹", "x": 440.543024, "y": 568.0633438, "width": 4.5529082, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝑎", "x": 445.204, "y": 570.7473755000001, "width": 3.8908945000000004, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 573.9110000000001, "fontSize": 7.2727},
        {"text": "(", "x": 450.346, "y": 565.3734418, "width": 3.3175458, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝑥", "x": 453.7631718, "y": 568.0633438, "width": 4.732235, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": ") −", "x": 459.3820782, "y": 565.3734418, "width": 12.3735492, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝐹", "x": 473.96732460000004, "y": 568.0633438, "width": 4.5529082, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝑏", "x": 478.49, "y": 570.8653755, "width": 3.8108948000000002, "height": 7.2727, "fontFamily": "sans-serif", "baseline": 574.029, "fontSize": 7.2727},
        {"text": "(", "x": 483.744, "y": 565.3734418, "width": 3.3175458, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝑥", "x": 487.16117180000003, "y": 568.0633438, "width": 4.732235, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": ")|", "x": 492.79004080000004, "y": 565.3734418, "width": 6.206699800000005, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "𝑑𝑥", "x": 500.55090620000004, "y": 568.0633438, "width": 10.062226000000026, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
        {"text": "(3)", "x": 548.0226952, "y": 565.4332174, "width": 10.5703186, "height": 9.9626, "fontFamily": "sans-serif", "baseline": 572.417, "fontSize": 9.9626},
    ];
    const prose = 'quantify distribution differences between two ranks:';
    const key = (run: Pick<PdfLayoutAtom, 'text' | 'x' | 'y'>) => `${run.text}:${run.x}:${run.y}`;

    it('terminates in an isolated bounded process and roots a stretched relation with the complete mathematical body', () => {
        const input: PdfLayoutAtom[] = [
            {...atom('∫', 390, 104, 6), y: 104, height: 18},
            {...atom('=', 380, 118, 7, 20), y: 110, height: 6, layoutFontSize: 10},
            atom('x', 408, 118, 6),
        ];
        const cases = [input, [...input].reverse(), [input[1], input[0], input[2]]];
        const sourcePath = fileURLToPath(new URL('../src/features/document-translation/core/pdfLayoutAnalysis.ts', import.meta.url));
        const typescriptPath = createRequire(import.meta.url).resolve('typescript');
        const program = `
const fs = require('node:fs'), crypto = require('node:crypto'), ts = require(${JSON.stringify(typescriptPath)});
const source = fs.readFileSync(${JSON.stringify(sourcePath)}, 'utf8'), exportsPort = {};
new Function('exports', ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exportsPort);
console.log('loaded-before-call:' + crypto.createHash('sha256').update(source).digest('hex'));
const cases = ${JSON.stringify(cases)}, before = JSON.stringify(cases);
const results = cases.map(atoms => exportsPort.pdfLayoutLines(atoms));
console.log('result:' + JSON.stringify({results, unchanged:before===JSON.stringify(cases)}));
`;
        const child = spawnSync(process.execPath, ['-e', program], {encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024});
        console.info('pdfLayout-raised-operator-child:' + JSON.stringify({status: child.status, signal: child.signal, error: child.error?.message, stdout: child.stdout, stderr: child.stderr}));
        expect(child.stdout).toContain('loaded-before-call:');
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        const output = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('result:'))!.slice('result:'.length));
        expect(output.unchanged).toBe(true);
        for (const result of output.results) expect(result).toMatchObject([{text: '= ∫ x', baseline: 118, runs: [input[1], input[0], input[2]]}]);
        // The child proves termination first; the direct calls then cover the same public function in this worker.
        for (const values of cases) expect(pdfLayoutLines(values)).toEqual(output.results[0]);
    }, 10_000);

    it('keeps actual ARGUS p7 prose translatable while its raised integral and complete equation stay preserved', () => {
        const input = structuredClone(real), before = structuredClone(input);
        const lines = pdfLayoutLines(input);
        expect(lines.find(line => line.runs.some(run => run.text === prose))?.text).toBe(prose);
        const equation = lines.find(line => line.runs.some(run => run.text === '∫'))!;
        expect(equation.text).toContain('=');
        expect(equation.baseline).toBeCloseTo(572.417, 2);
        const result = analyze(input);
        expect(result.blocks.find(block => block.source.includes(prose))).toMatchObject({kind: 'text', preserveSource: false});
        const preserved = result.blocks.filter(block => block.preserveSource).flatMap(block => block.lines?.flatMap(line => line.runs ?? []) ?? []);
        const formula = input.filter(run => run.text !== prose);
        expect(preserved.map(key).sort()).toEqual(formula.map(key).sort());
        expect(preserved.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(formula.sort((a, b) => key(a).localeCompare(key(b))));
        expect(input).toEqual(before);
    });

    it.each(['∫', '∬', '∭', '∮', '∯', '∰', '∑', '∏', '⋃', '⋂'])
    ('associates a raised %s only with the adjacent relation and same-baseline mathematical body', operator => {
        const before = atom('A complete introductory paragraph ends here:', 318, 100, 213);
        const mark = {...atom(operator, 390, 104, 6), height: 18}, relation = atom('=', 380, 118, 7), value = atom('x', 408, 118, 6);
        const input = [before, mark, relation, value], original = structuredClone(input);
        const lines = pdfLayoutLines(input);
        expect(lines.find(line => line.runs.some(run => run.text === before.text))?.text).toBe(before.text);
        const formula = lines.find(line => line.runs.some(run => run.text === operator))!;
        expect(formula.baseline).toBe(118);
        expect(formula.runs).toEqual([relation, mark, value]);
        expect(input).toEqual(original);
    });

    it.each(['missing relation', 'non-relation', 'relation at right', 'overlapping relation', 'distant relation', 'relation font',
        'near baseline', 'distant baseline', 'no ink overlap', 'below relation', 'missing body', 'overlapping body', 'distant body', 'body baseline', 'body font', 'ordinary body words'] as const)
    ('does not move a symbol to another row with %s', mode => {
        const mark = {...atom('∫', 390, 104, 6), height: 18}, relation = atom('=', 380, 118, 7), value = atom('x', 408, 118, 6);
        if (mode === 'non-relation') relation.text = ':';
        if (mode === 'relation at right') relation.x = 390;
        if (mode === 'overlapping relation') relation.x = 385;
        if (mode === 'distant relation') relation.x = 376;
        if (mode === 'relation font') relation.fontSize = 12;
        if (mode === 'near baseline') relation.baseline = value.baseline = 110;
        if (mode === 'distant baseline') relation.baseline = value.baseline = 123;
        if (mode === 'no ink overlap') mark.height = 10;
        if (mode === 'below relation') mark.y = 120;
        if (mode === 'overlapping body') value.x = 395;
        if (mode === 'distant body') value.x = 419;
        if (mode === 'body baseline') value.baseline = 121;
        if (mode === 'body font') value.fontSize = 12;
        if (mode === 'ordinary body words') value.text = 'ordinary words';
        const input = [mark, ...(mode === 'missing relation' ? [] : [relation]), ...(mode === 'missing body' ? [] : [value])];
        const original = structuredClone(input);
        const line = pdfLayoutLines(input).find(candidate => candidate.runs.some(run => run.text === '∫'))!;
        expect(line.runs).not.toContainEqual(relation);
        expect(line.runs.find(run => run.text === '∫')).toEqual(mark);
        expect(input).toEqual(original);
    });

    it('keeps an inline integral on the prose baseline even with a plausible lower equation beside it', () => {
        const prose = atom('The integral symbol', 50, 100, 98), integral = atom('∫', 150, 100, 6);
        const relation = atom('=', 140, 114, 7), value = atom('x', 167, 114, 6);
        const input = [prose, integral, relation, value];
        expect(pdfLayoutLines(input).find(line => line.runs.some(run => run.text === prose.text))?.runs).toEqual([prose, integral]);
        expect(analyze(input).blocks.find(block => block.source.includes(prose.text))).toMatchObject({kind: 'text', preserveSource: false});
    });

    it.each([388, 401])('never borrows a mathematical anchor across the actual cell divider at x=%i', x => {
        const integral = {...atom('∫', 390, 104, 6), height: 18};
        const input = [integral, atom('=', 380, 118, 7), atom('x', 408, 118, 6)];
        expect(pdfLayoutLines(input).find(line => line.runs.some(run => run.text === '∫'))?.baseline).toBe(118);
        const lines = pdfLayoutLines(input, [{x, y: 90, width: .5, height: 50}]);
        expect(lines.find(line => line.runs.some(run => run.text === '∫'))).toMatchObject({baseline: 104, runs: [integral]});
    });

    it('keeps a raised operator in its actual upper table row instead of borrowing the next row equation', () => {
        const integral = {...atom('∫', 390, 104, 6), y: 104, height: 18};
        const input = [integral, atom('=', 380, 120, 7), atom('x', 408, 120, 6)], original = structuredClone(input);
        const graphics = [
            {kind: 'path' as const, x: 370, y: 95, width: 0, height: 40},
            {kind: 'path' as const, x: 550, y: 95, width: 0, height: 40},
            ...[95, 109, 135].map(y => ({kind: 'path' as const, x: 370, y, width: 180, height: 0})),
        ];
        const result = analyze(input, graphics);
        expect(result.blocks.find(block => block.source.includes('∫'))).toMatchObject({source: '∫', kind: 'table', cellBounds: {x: 370, y: 95, width: 180, height: 14}});
        for (const value of ['=', 'x']) expect(result.blocks.find(block => block.source === value)?.cellBounds).toEqual({x: 370, y: 109, width: 180, height: 26});
        expect(result.blocks.flatMap(block => block.lines!.flatMap(line => line.runs!))).toEqual(input);
        expect(input).toEqual(original);
    });

    it.each(['isolated fraction bar', 'left side only', 'right side only', 'lower side only', 'upper side only', 'outside column', 'above baselines', 'below baselines'] as const)
    ('retains the legitimate mathematical baseline beside an unseparating %s', mode => {
        const input = [{...atom('∫', 390, 104, 6), y: 104, height: 18}, atom('=', 380, 120, 7), atom('x', 408, 120, 6)];
        const x = mode === 'outside column' ? 20 : 370;
        const y = mode === 'above baselines' ? 100 : mode === 'below baselines' ? 124 : 109;
        const edgeY = mode === 'lower side only' ? 109 : 90;
        const edgeHeight = mode === 'upper side only' ? 19 : 45;
        const left = {kind: 'path' as const, x, y: edgeY, width: 0, height: edgeHeight};
        const right = {...left, x: x + 180};
        const graphics = [{kind: 'path' as const, x, y, width: 180, height: 0},
            ...(mode === 'isolated fraction bar' || mode === 'right side only' ? [] : [left]),
            ...(mode === 'isolated fraction bar' || mode === 'left side only' ? [] : [right])];
        const result = analyze(input, graphics);
        const line = result.blocks.flatMap(block => block.lines!).find(candidate => candidate.runs!.some(run => run.text === '∫'))!;
        expect(line).toMatchObject({text: '= ∫ x', baseline: 120});
        expect(line.runs).toEqual([input[1], input[0], input[2]]);
    });

    it.each([1.99, 2.01])('retains the exact connected-row endpoint tolerance at %fpt', offset => {
        const integral = {...atom('∫', 390, 104, 6), y: 104, height: 18};
        const input = [integral, atom('=', 380, 120, 7), atom('x', 408, 120, 6)];
        const graphics = [{kind: 'path' as const, x: 370, y: 109, width: 180, height: 0},
            {kind: 'path' as const, x: 370 - offset, y: 95, width: 0, height: 40},
            {kind: 'path' as const, x: 550 + offset, y: 95, width: 0, height: 40}];
        const line = analyze(input, graphics).blocks.flatMap(block => block.lines!).find(candidate => candidate.runs!.some(run => run.text === '∫'))!;
        expect(line.baseline).toBe(offset < 2 ? 104 : 120);
        expect(line.runs).toEqual(offset < 2 ? [integral] : [input[1], integral, input[2]]);
    });

    it.each([40, 80, 160])('keeps divider endpoint reads linear for %i horizontal strokes, with and without a candidate operator', horizontalCount => {
        const verticalCount = horizontalCount * 10;
        for (const hasOperator of [false, true]) {
            let reads = 0;
            const graphics = Array.from({length: verticalCount}, (_, index) => ({kind: 'path' as const,
                get x() {reads++; return 100 + index % 400;}, y: 100 + index % 200, width: 0, height: 20}));
            for (let index = 0; index < horizontalCount; index++) graphics.push({kind: 'path', x: 10, y: 100 + index * 3, width: 6, height: 0});
            const body = atom('Ordinary readable body.', 50, 60, 120);
            const input = [body, ...(hasOperator ? [atom('∫', 50, 400, 6)] : [])];
            const result = analyze(input, graphics), endpointReads = reads;
            expect(result.blocks.some(block => block.source === body.text && !block.preserveSource)).toBe(true);
            if (hasOperator) expect(result.blocks.some(block => block.source === '∫')).toBe(true);
            expect(endpointReads).toBeLessThan(verticalCount * 20);
        }
    });
});
