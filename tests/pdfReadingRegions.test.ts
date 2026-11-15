import {describe, expect, it} from 'vitest';
import type {PdfDocumentBlock, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import type {PdfReadingEntry, PdfReadingRect, PdfReadingRegionEntry, PdfReadingTextEntry} from '@/src/features/document-translation/core/pdfReadingPlan';
import {groupPdfReadingRegions} from '@/src/features/document-translation/core/pdfReadingRegions';

const rect = (x: number, y: number, width = 40, height = 10): PdfReadingRect => ({x, y, width, height});
const block = (segmentIndex: number, box: PdfReadingRect, text = 'x', kind: PdfDocumentBlock['kind'] = 'formula', extras: Partial<PdfDocumentBlock> = {}): PdfDocumentBlock => ({
    ...box, segmentIndex, kind, fontSize: 10, lineHeight: 12, lineCount: 1, fontFamily: 'math', fontWeight: 400, textAlign: 'left',
    lines: [{...box, text, baseline: box.y + 8}], ...extras,
});
const image = (id: string, box: PdfReadingRect, role = 'formula', indexes = [-1]): PdfReadingRegionEntry => ({kind: 'region', id, sourceRect: box, role, segmentIndexes: indexes, pageNumber: 1});
const text = (segmentIndex: number, box: PdfReadingRect, value = `完整译文${segmentIndex}`): PdfReadingTextEntry => ({kind: 'text', id: `t${segmentIndex}`, pageNumber: 1, segmentIndex, role: 'text', sourceRect: box, source: 'Original source', text: value, translated: true});
const page = (blocks: PdfDocumentBlock[], extras: Partial<PdfDocumentPage> = {}): PdfDocumentPage => ({pageNumber: 1, width: 600, height: 800, segmentIndexes: [], blocks, ...extras});
const regions = (entries: readonly PdfReadingEntry[]) => entries.filter((entry): entry is PdfReadingRegionEntry => entry.kind === 'region');
const group = (blocks: PdfDocumentBlock[], entries: readonly PdfReadingEntry[], extras: Partial<PdfDocumentPage> = {}, controls: number[] = []) => groupPdfReadingRegions(page(blocks, extras), entries, new Set(controls));

/** 来自公开 PDF 第 18 页的原始逐行、定界符和 prime 几何；文字改为通用数学条件，编码只表示未知原字形。 */
function splitCases() {
    const run = (box: PdfReadingRect, value: string, baseline: number) => ({...box, text: value, baseline});
    const upper = block(244, rect(263.09653, 441.6304, 148.57097, 12.8414), 'case x > 0', 'text', {fontSize: 11, lines: [{
        ...rect(263.09653, 441.6304, 148.57097, 12.8414), text: '\u0081 case x > 0', baseline: 452.3378,
        runs: [run(rect(263.09653, 441.6304, 9.922, 11), '\u0081', 450.4964), run(rect(273.01852, 443.4718, 138.64898, 11), 'case x > 0', 452.3378)],
    }]});
    const lower = block(245, rect(183.34407, 456.6278, 228.32343, 24.156), 'f(x) ≔ cases', 'text', {fontSize: 11, lineCount: 2, lines: [{
        ...rect(183.34407, 456.6278, 228.32343, 16.5), text: 'f(x) ≔ \u0082 case x < 0', baseline: 465.4938,
        runs: [run(rect(183.34407, 456.6278, 76.69688, 11), 'f(x) ≔', 465.4938), run(rect(263.09653, 462.1278, 9.922, 11), '\u0082', 470.9938),
            run(rect(273.01852, 456.6278, 138.64898, 11), 'case x < 0', 465.4938)],
    }, {
        ...rect(263.09653, 468.2405, 44.18699, 12.5433), text: '\u0083 case', baseline: 478.6498,
        runs: [run(rect(263.09653, 468.2405, 9.922, 11), '\u0083', 477.1065), run(rect(273.01852, 469.7838, 34.265, 11), 'case', 478.6498)],
    }]});
    const condition = block(246, rect(335.65253, 469.7838, 45.309, 11), 'otherwise', 'text', {fontSize: 11, lines: [{
        ...rect(335.65253, 469.7838, 45.309, 11), text: 'otherwise', baseline: 478.6498,
        runs: [run(rect(335.65253, 469.7838, 45.309, 11), 'otherwise', 478.6498)],
    }]});
    const middle = block(-1, rect(263.09653, 447.743099, 9.922, 11), '\u0084', 'formula', {fontSize: 11, lines: [{
        ...rect(263.09653, 447.743099, 9.922, 11), text: '\u0084', baseline: 456.609099,
        runs: [run(rect(263.09653, 447.743099, 9.922, 11), '\u0084', 456.609099)],
    }]});
    const end = block(-1, rect(263.09653, 474.3752, 9.922, 11), '{', 'formula', {fontSize: 11, lines: [{
        ...rect(263.09653, 474.3752, 9.922, 11), text: '{', baseline: 483.2412,
        runs: [run(rect(263.09653, 474.3752, 9.922, 11), '{', 483.2412)],
    }]});
    const prime = block(-1, rect(238.9905, 455.2946, 3.1339, 7.7), '′', 'formula', {fontSize: 7.7});
    const otherPrime = block(-1, rect(388.03452, 456.1086, 3.1339, 7.7), '′', 'formula', {fontSize: 7.7});
    const number = block(-1, rect(504.85144, 456.6278, 19.558, 11), '(24)', 'formula', {fontSize: 11});
    const before = block(243, rect(70.86614, 419.1972, 380.60746, 13.2902), 'definition', 'text', {fontSize: 11});
    const after = block(247, rect(70.86614, 499.7172, 455.74331, 38.401), 'following ordinary paragraph', 'text', {fontSize: 11, lineCount: 3});
    const targets = [text(243, before), text(244, upper, '第一种完整条件'), text(245, lower, '第二、三种完整条件'), text(246, condition, '完整补充条件'), text(247, after)];
    const blocks = [before, upper, middle, prime, otherPrime, lower, condition, end, number, after];
    const entries = [targets[0], targets[1], image('middle', middle), image('prime', prime), image('other-prime', otherPrime), targets[2], targets[3], image('end', end), image('number', number), targets[4]];
    return {blocks, entries, targets, upper, lower, middle, end};
}

function displayMath(expression = 'λ → kernel(x) + 𝑦') {
    const body = block(1, rect(245, 300, 110, 14), expression, 'text', {lines: [{
        ...rect(245, 300, 110, 14), text: expression, baseline: 310,
        runs: [{...rect(245, 300, 110, 14), text: expression, baseline: 310}],
    }]});
    const number = block(-1, rect(500, 300, 15, 10), '(7)', 'formula', {lines: [{...rect(500, 300, 15, 10), text: '(7)', baseline: 310}]});
    const ordinary = (index: number, y: number) => block(index, rect(50, y, 500, 50), 'ordinary prose', 'text', {lineCount: 2, lines: [
        {...rect(50, y, 500), text: 'ordinary first paragraph line', baseline: y + 8}, {...rect(50, y + 40, 500), text: 'ordinary last paragraph line', baseline: y + 48},
    ]});
    const before = ordinary(0, 220), after = ordinary(2, 340), targets = [text(0, before), text(1, body), text(2, after)];
    return {body, number, before, after, targets, blocks: [before, body, number, after], entries: [targets[0], targets[1], image('number', number), targets[2]]};
}

describe('PDF preserved image components with unchanged text sequence', () => {
    it.each(['empty', 'translated', 'source-only', 'source-control'] as const)('preserves %s text entries without consulting page geometry when no region exists', kind => {
        const targets = kind === 'empty' ? [] : [text(kind === 'source-only' ? -1 : 0, rect(40, 100), kind === 'source-control' ? '\u0093' : 'First paragraph'), text(1, rect(40, 180), 'Second paragraph')];
        const original = JSON.stringify(targets), entries = Object.freeze(targets.map(entry => Object.freeze(entry)));
        const sourcePage = {...page([]), get blocks(): PdfDocumentBlock[] {throw new Error('No-region plans must not inspect page geometry');}};
        const output = groupPdfReadingRegions(sourcePage, entries, new Set(kind === 'source-control' ? [0] : []));
        expect(output).toEqual(entries); expect(output).not.toBe(entries);
        output.forEach((entry, index) => expect(entry).toBe(entries[index]));
        expect(JSON.stringify(entries)).toBe(original);
    });

    it('joins a complete centered single-line mathematical body with its same-baseline terminal number before the unchanged body text', () => {
        for (const expression of ['λ → kernel(x) + 𝑦', '𝔇Σ ≔ 𝖲𝖾𝗍(𝐾)', 'ℳ = f(x)', 'x = 1']) {
            const fixture = displayMath(expression), original = JSON.stringify(fixture), output = group(fixture.blocks, fixture.entries);
            const pictures = regions(output); expect(pictures).toHaveLength(1);
            expect(pictures[0].sourceRect.x).toBeLessThanOrEqual(fixture.body.x);
            expect(pictures[0].sourceRect.x + pictures[0].sourceRect.width).toBeGreaterThanOrEqual(515);
            expect(pictures[0].segmentIndexes).toEqual([-1, 1]);
            expect(output).toEqual([fixture.targets[0], pictures[0], fixture.targets[1], fixture.targets[2]]);
            expect(output.filter(entry => entry.kind === 'text')).toEqual(fixture.targets); expect(JSON.stringify(fixture)).toBe(original);
        }
    });
    it('uses the nearest surrounding paragraphs when multiple aligned prose paragraphs support a display formula', () => {
        const fixture = displayMath();
        const move = (entry: PdfDocumentBlock, segmentIndex: number, y: number): PdfDocumentBlock => ({...entry, segmentIndex, y, lines: entry.lines!.map(line => ({...line, y: line.y + y - entry.y, baseline: (line.baseline ?? line.y) + y - entry.y}))});
        const before = move(fixture.before, 4, 100), after = move(fixture.after, 5, 450);
        const targets = [text(4, before), ...fixture.targets, text(5, after)];
        const output = group([before, ...fixture.blocks, after], [targets[0], fixture.entries[0], fixture.entries[1], fixture.entries[2], fixture.entries[3], targets.at(-1)!]);
        expect(output.filter(entry => entry.kind === 'text')).toEqual(targets);
        expect(regions(output)).toHaveLength(1); expect(regions(output)[0].segmentIndexes).toEqual([-1, 1]);
    });

    it('requires a complete mathematical line rather than ordinary sentences, lists, headings or uncertain source glyphs', () => {
        const changes: Array<(fixture: ReturnType<typeof displayMath>) => void> = [
            ...['heading', 'caption', 'footer', 'metadata', 'figure-label'].map(kind => (fixture: ReturnType<typeof displayMath>) => {fixture.body.kind = kind as PdfDocumentBlock['kind'];}),
            fixture => {fixture.body.lineCount = 2;}, fixture => {fixture.body.lines = undefined;},
            fixture => {fixture.body.fontSize = NaN;}, fixture => {fixture.body.fontSize = 0;},
            fixture => {fixture.body.lines![0].width = NaN;}, fixture => {fixture.body.lines![0].x = 10;},
            fixture => {fixture.body.lines![0].baseline = undefined;}, fixture => {fixture.body.lines![0].runs = undefined;},
            fixture => {fixture.body.lines![0].runs![0].height = 0;}, fixture => {fixture.body.lines![0].runs![0].x = 10;},
            fixture => {fixture.body.lines![0].runs![0].baseline = undefined;},
        ];
        for (const change of changes) {
            const fixture = displayMath(); change(fixture);
            const output = group(fixture.blocks, fixture.entries); expect(regions(output)[0].segmentIndexes).toEqual([-1]);
            expect(output.filter(entry => entry.kind === 'text')).toEqual(fixture.targets);
        }
        for (const expression of ['ordinary phrase = x', 'x follows y', '𝑥name = y', '𝑥𠀀 = y', '- x = y', '* x = y', '1. x = y', 'x = \u0091', 'x = 😀']) {
            const fixture = displayMath(expression), output = group(fixture.blocks, fixture.entries);
            expect(regions(output)[0].segmentIndexes, expression).toEqual([-1]);
        }
    });

    it('requires two supporting prose sides, a centered corridor and a valid terminal line in that corridor', () => {
        const changes: Array<(fixture: ReturnType<typeof displayMath>) => void> = [
            fixture => {fixture.blocks.splice(fixture.blocks.indexOf(fixture.before), 1);},
            fixture => {fixture.blocks.splice(fixture.blocks.indexOf(fixture.after), 1);},
            fixture => {fixture.before.width = 200;}, fixture => {fixture.after.x = 350;},
            fixture => {fixture.before.x = 20; fixture.before.width = 530;}, fixture => {fixture.after.width = 449;},
            fixture => {fixture.body.x = 100; fixture.body.lines![0].x = 100; fixture.body.lines![0].runs![0].x = 100;},
            fixture => {for (const item of [fixture.before, fixture.after]) {item.x = 240; item.width = 129; item.lines!.forEach(line => {line.x = 240; line.width = 129;});}},
            fixture => {fixture.number.x = 340;}, fixture => {fixture.number.x = 590;},
            fixture => {fixture.number.lines![0].baseline = 330;}, fixture => {fixture.number.lines![0].baseline = undefined;},
            fixture => {fixture.number.lines![0].width = NaN;},
            fixture => {fixture.number.lines![0].x = 10;},
            fixture => {fixture.number.lines!.push({...rect(500, 300, 15, 10), text: '', baseline: 310});},
        ];
        for (const change of changes) {
            const fixture = displayMath(); change(fixture);
            fixture.entries.find(entry => entry.id === 'number')!.sourceRect = rect(fixture.number.x, fixture.number.y, fixture.number.width, fixture.number.height);
            expect(regions(group(fixture.blocks, fixture.entries))[0].segmentIndexes, change.toString()).toEqual([-1]);
        }
        const multiple = displayMath(); multiple.body.lines!.push({...multiple.body.lines![0]});
        expect(regions(group(multiple.blocks, multiple.entries))[0].segmentIndexes).toEqual([-1]);
    });

    it('does not absorb ordinary text between a display formula and its number or cross a supported two-column gutter', () => {
        const fixture = displayMath(), obstacle = block(9, rect(400, 300, 60, 10), 'ordinary prose', 'text', {lines: [{...rect(400, 300, 60), text: 'ordinary prose', baseline: 318}]});
        expect(regions(group([...fixture.blocks, obstacle], [...fixture.entries, text(9, obstacle)]))[0].segmentIndexes).toEqual([-1]);
        const columns = [rect(50, 220, 240, 60), rect(320, 220, 230, 60), rect(50, 340, 240, 60), rect(320, 340, 230, 60)].map((box, index) => block(index + 10, box, 'column prose', 'text', {lineCount: 2, lines: [
            {...rect(box.x, box.y, box.width), text: 'top', baseline: box.y + 8}, {...rect(box.x, box.y + 50, box.width), text: 'bottom', baseline: box.y + 58},
        ]}));
        expect(regions(group([...fixture.blocks, ...columns], [...fixture.entries, ...columns.map(item => text(item.segmentIndex, item))]))[0].segmentIndexes).toEqual([-1]);
    });
    it('keeps an encoded stretched cases delimiter and translated body in one complete image without changing any text', () => {
        const fixture = splitCases(), original = JSON.stringify(fixture);
        const output = group(fixture.blocks, fixture.entries), pictures = regions(output);
        expect(pictures).toHaveLength(1);
        expect(pictures[0].sourceRect.x).toBeLessThanOrEqual(183.34407);
        expect(pictures[0].sourceRect.y).toBeLessThanOrEqual(441.6304);
        expect(pictures[0].sourceRect.x + pictures[0].sourceRect.width).toBeGreaterThanOrEqual(524.40944);
        expect(pictures[0].sourceRect.y + pictures[0].sourceRect.height).toBeGreaterThanOrEqual(485.3752);
        expect(pictures[0].sourceRect.y).toBeGreaterThan(432.4874);
        expect(pictures[0].sourceRect.y + pictures[0].sourceRect.height).toBeLessThan(499.7172);
        expect(pictures[0].segmentIndexes).toEqual([-1, 244, 245, 246]);
        expect(output.filter(entry => entry.kind === 'text')).toEqual(fixture.targets);
        fixture.targets.forEach(target => expect(output.find(entry => entry.id === target.id)).toBe(target));
        expect(output.indexOf(pictures[0])).toBeLessThan(output.indexOf(fixture.targets[1]));
        expect(JSON.stringify(fixture)).toBe(original);
    });

    it('recognizes Unicode stretched delimiter pieces without depending on an encoded control value', () => {
        const fixture = splitCases();
        for (const item of [fixture.upper, fixture.lower, fixture.middle, fixture.end]) for (const line of item.lines!) for (const run of line.runs!) {
            if (run.width === 9.922) run.text = item === fixture.end ? '⎩' : '⎧';
        }
        expect(regions(group(fixture.blocks, fixture.entries))).toHaveLength(1);
    });

    it('requires complete source run geometry, a long delimiter, existing math fragments and a mathematical body', () => {
        const changes: Array<(fixture: ReturnType<typeof splitCases>) => void> = [
            fixture => {fixture.upper.lines![0].runs = undefined; fixture.lower.lines!.forEach(line => {line.runs = undefined;});},
            fixture => {fixture.lower.lines![0].runs![0].width = NaN;},
            fixture => {fixture.upper.lines![0].baseline = undefined;},
            fixture => {fixture.upper.lines![0].runs![0].baseline = undefined;},
            fixture => {fixture.upper.lines![0].x = 10;},
            fixture => {fixture.upper.lines![0].runs![0].x = 10;},
            fixture => {fixture.lower.lines![0].runs![0].x = 10;},
            fixture => {fixture.middle.lines![0].runs![0].width = 30;},
            fixture => {fixture.middle.lines![0].width = NaN;},
            fixture => {fixture.end.lines![0].runs![0].text = '\u0085';},
            fixture => {fixture.blocks.splice(fixture.blocks.indexOf(fixture.middle), 1); fixture.entries.splice(fixture.entries.findIndex(entry => entry.id === 'middle'), 1);},
            fixture => {fixture.upper.height = 60;},
            fixture => {fixture.upper.lines![0].text = 'ordinary words'; fixture.lower.lines!.forEach(line => {line.text = 'ordinary words';});},
            fixture => {fixture.upper.lines![0].runs![0].x += 100; fixture.lower.lines!.forEach(line => {line.runs!.find(run => run.width === 9.922)!.x += 100;});},
            fixture => {fixture.end.y += 100; fixture.end.lines![0].y += 100; fixture.end.lines![0].runs![0].y += 100;},
        ];
        for (const change of changes) {
            const fixture = splitCases(); change(fixture);
            const output = group(fixture.blocks, fixture.entries);
            expect(regions(output), change.toString()).not.toHaveLength(1);
            expect(output.filter(entry => entry.kind === 'text')).toEqual(fixture.targets);
        }
        const short = splitCases();
        for (const item of short.blocks) {item.y = 440 + (item.y - 440) * .1; item.height *= .1; for (const line of item.lines ?? []) {
            line.y = 440 + (line.y - 440) * .1; line.height *= .1; for (const run of line.runs ?? []) {run.y = 440 + (run.y - 440) * .1; run.height *= .1;}
        }}
        const output = regions(group(short.blocks, short.entries));
        expect(output.every(entry => entry.sourceRect.x > 230)).toBe(true);
    });

    it('does not let a detected cases body swallow ordinary prose or cross supported prose columns', () => {
        const fixture = splitCases(), obstacle = block(9, rect(170, 445, 65, 11), 'ordinary prose', 'text');
        expect(regions(group([...fixture.blocks, obstacle], [...fixture.entries, text(9, obstacle)]))).not.toHaveLength(1);
        const lines = (box: PdfReadingRect) => [{...rect(box.x, box.y, box.width), text: 'ordinary top', baseline: box.y + 8}, {...rect(box.x, box.y + box.height - 10, box.width), text: 'ordinary bottom', baseline: box.y + box.height - 2}];
        const columns = [rect(50, 350, 200, 80), rect(280, 350, 240, 80), rect(50, 490, 200, 80), rect(280, 490, 240, 80)].map((box, index) => block(index + 10, box, 'ordinary column prose', 'text', {lineCount: 2, lines: lines(box)}));
        expect(regions(group([...fixture.blocks, ...columns], [...fixture.entries, ...columns.map(item => text(item.segmentIndex, item))]))).not.toHaveLength(1);
    });

    it('keeps unsupported broad original crops separate even when a delimiter is otherwise confirmed', () => {
        const fixture = splitCases();
        const entries = fixture.entries.filter(entry => !['prime', 'other-prime'].includes(entry.id)).map(entry => entry.id === 'middle' ? image('middle', rect(100, 447.743099, 173.01853, 11)) : entry);
        expect(regions(group(fixture.blocks, entries))).not.toHaveLength(1);
    });
    it('keeps overlapping upper and lower formula lines and a distant terminal number in one source image', () => {
        const upper = rect(40, 100, 80, 12), lower = rect(40, 119, 170, 12), number = rect(500, 110, 15, 11);
        const before = text(0, rect(20, 60, 520, 20)), after = text(1, rect(20, 150, 520, 20));
        const blocks = [block(-1, upper, 'mapping : A → B'), block(-1, lower, 'mapping = value'), block(-1, number, '(27)'),
            block(0, before.sourceRect, 'before', 'text', {lineCount: 2}), block(1, after.sourceRect, 'after', 'text', {lineCount: 2})];
        const entries = [before, image('upper', upper), image('lower', lower), after, image('number', number)];
        const original = JSON.stringify({blocks, entries});
        const output = group(blocks, entries), pictures = regions(output);
        expect(pictures).toHaveLength(1);
        expect(pictures[0].sourceRect.x).toBeLessThanOrEqual(40); expect(pictures[0].sourceRect.y).toBeLessThanOrEqual(100);
        expect(pictures[0].sourceRect.x + pictures[0].sourceRect.width).toBeGreaterThanOrEqual(515);
        expect(pictures[0].sourceRect.y + pictures[0].sourceRect.height).toBeGreaterThanOrEqual(131);
        expect(output).toEqual([before, pictures[0], after]); expect(output[0]).toBe(before); expect(output[2]).toBe(after);
        expect(JSON.stringify({blocks, entries})).toBe(original);
    });

    it('unions partial figure and table containers but keeps nearby independent containers and their captions separate', () => {
        for (const role of ['figure', 'table']) {
            const first = rect(40, 100, 100, 80), overlap = rect(100, 150, 90, 60), independent = rect(220, 100, 100, 80);
            const caption = text(0, rect(40, 220, 280, 12), '完整图注');
            const output = group([block(0, caption.sourceRect, 'caption', 'caption')], [image('a', first, role), image('b', overlap, role), image('c', independent, role), caption]);
            expect(regions(output)).toHaveLength(2); expect(regions(output)[0].sourceRect).toEqual(rect(40, 100, 150, 110));
            expect(output.at(-1)).toBe(caption);
        }
    });

    it('links figure labels to their overlapping figure in either input order and merges contained provenance', () => {
        const outer = image('figure', rect(40, 100, 100, 80), 'figure', [1]);
        const label = image('label', rect(100, 95, 30, 15), 'figure-label', [2]);
        for (const entries of [[outer, label], [label, outer]]) {
            const output = regions(group([], entries)); expect(output).toHaveLength(1);
            expect(output[0].segmentIndexes.sort()).toEqual([1, 2]);
            expect(output[0].sourceRect.y).toBeLessThanOrEqual(95);
        }
        const inner = image('inner', rect(60, 120), 'formula', [2, 1]);
        expect(regions(group([], [outer, inner]))[0].segmentIndexes).toEqual([1, 2]);
    });

    it('keeps all inner condition targets in their original order while preserving aligned source conditions in the image', () => {
        const first = rect(40, 100, 40, 10), second = rect(40, 120, 40, 10), number = rect(400, 110, 15, 10), condition = rect(90, 100, 200, 30);
        const target = text(3, condition, '完整条件第一行\n完整条件第二行'), following = text(4, rect(20, 150, 500, 20));
        const blocks = [block(-1, first), block(9, second, '\u0093idΓ', 'text'), block(-1, number, '(A.3)'),
            block(3, condition, 'condition', 'text', {lineCount: 2, lines: [
                {...rect(90, 100, 200, 10), text: 'first case', baseline: 108}, {...rect(90, 120, 100, 10), text: 'second case', baseline: 128},
            ]}), block(4, following.sourceRect, 'after', 'text', {lineCount: 2})];
        const output = group(blocks, [image('a', first), image('control', second, 'text', [9]), target, image('n', number), following], {}, [9]);
        const pictures = regions(output); expect(pictures).toHaveLength(1); expect(pictures[0].segmentIndexes).toEqual([-1, 9, 3]);
        expect(output.filter(entry => entry.kind === 'text')).toEqual([target, following]); expect(output.indexOf(pictures[0])).toBeLessThan(output.indexOf(target));
    });

    it('does not exempt unaligned, incomplete, left-side, out-of-band or legacy condition geometry from the prose barrier', () => {
        const first = rect(40, 100, 40, 30), number = rect(400, 110, 15, 10);
        const math = block(-1, first, 'cases', 'formula', {lines: [{...rect(40, 100), text: 'first', baseline: 108}, {...rect(40, 120), text: 'second', baseline: 128}]});
        const variants: PdfDocumentBlock[] = [
            block(3, rect(90, 100, 200, 30), 'condition', 'text', {lines: undefined}),
            block(3, rect(90, 100, 200, 30), 'condition', 'text', {lines: [{...rect(90, 100, 200), text: 'condition', baseline: 115}]}),
            block(3, rect(90, 100, 200, 30), 'condition', 'text', {lines: [{...rect(90, 100, 200), text: 'condition', baseline: undefined}]}),
            block(3, rect(90, 100, 200, 30), 'condition', 'text', {lines: [{...rect(NaN, 100, 200), text: 'invalid geometry, finite baseline', baseline: 108}]}),
            block(3, rect(90, 100, 200, 30), 'condition', 'text', {lines: [{...rect(400, 100, 200), text: 'escaped source line, matching baseline', baseline: 108}]}),
            block(3, rect(30, 100, 100, 30), 'condition', 'text'),
            block(3, rect(90, 95, 200, 30), 'condition', 'text'),
            block(3, rect(90, 110, 200, 30), 'condition', 'text'),
        ];
        for (const condition of variants) {
            const target = text(3, condition);
            const output = group([math, block(-1, number, '(1)'), condition], [image('m', first), target, image('n', number)]);
            expect(regions(output), JSON.stringify(condition)).toHaveLength(2); expect(output).toContain(target);
        }
    });

    it('rechecks a transitive mathematical union against every ordinary source line', () => {
        const a = rect(100, 100, 20), b = rect(150, 100, 20), c = rect(100, 130, 20), obstacle = rect(90, 117, 100, 8);
        const target = text(0, obstacle);
        const output = group([block(-1, a), block(-1, b), block(-1, c), block(0, obstacle, 'ordinary prose', 'text', {lines: undefined})],
            [image('a', a), image('b', b), target, image('c', c)]);
        expect(regions(output)).toHaveLength(2); expect(output).toContain(target);
        expect(regions(output).every(entry => entry.sourceRect.height < 30)).toBe(true);
    });

    it('keeps same-baseline formulas and markers within supported prose columns rather than spanning their gutter', () => {
        const left = rect(20, 20, 200, 160), right = rect(250, 20, 200, 160), formula = rect(160, 100, 20), number = rect(420, 100, 15);
        const lines = (box: PdfReadingRect) => [{...rect(box.x, 20, box.width), text: 'top', baseline: 28}, {...rect(box.x, 170, box.width), text: 'bottom', baseline: 178}];
        const output = group([block(0, left, 'left prose', 'text', {lineCount: 2, lines: lines(left)}), block(1, right, 'right prose', 'text', {lineCount: 2, lines: lines(right)}), block(-1, formula), block(-1, number, '(8)')],
            [text(0, left), image('left-math', formula), image('right-number', number), text(1, right)]);
        expect(regions(output)).toHaveLength(2);
    });

    it('attaches each terminal marker to just one nearest subject and never uses it to bridge distant subjects', () => {
        const first = rect(40, 100, 60), second = rect(250, 100, 60), number = rect(500, 100, 15);
        for (const marker of ['(14)', '□']) {
            const output = regions(group([block(-1, first), block(-1, second), block(-1, number, marker)], [image('a', first), image('b', second), image('n', number)]));
            expect(output).toHaveLength(2); expect(output[0].sourceRect.x + output[0].sourceRect.width).toBeLessThan(120);
            expect(output[1].sourceRect.x).toBeGreaterThan(240); expect(output[1].sourceRect.x + output[1].sourceRect.width).toBeGreaterThanOrEqual(515);
        }
        expect(regions(group([block(-1, number, '(1)')], [image('alone', number)]))).toHaveLength(1);
    });

    it('requires single-line compact marker evidence instead of treating a tall or wide math block as a terminal number', () => {
        const formula = rect(40, 100), tall = rect(400, 100, 15, 50), wide = rect(400, 100, 80, 10), multiline = rect(400, 100, 15, 10);
        for (const marker of [block(-1, tall, '(1)'), block(-1, wide, '(1)'), block(-1, multiline, '(1)', 'formula', {lineCount: 2}), block(-1, multiline, 'word'), block(-1, multiline, '(1)', 'formula', {lines: undefined})]) {
            expect(regions(group([block(-1, formula), marker], [image('m', formula), image('n', marker)]))).toHaveLength(2);
        }
    });

    it('does not let a broad existing crop containing only terminal markers bridge adjacent mathematical subjects', () => {
        const first = rect(60, 100, 30), marker = rect(110, 100, 15), wideCrop = rect(110, 100, 70), second = rect(185, 100, 30);
        const output = regions(group([block(-1, first), block(-1, marker, '(1)'), block(-1, second)],
            [image('first', first), image('wide-marker', wideCrop), image('second', second)]));
        expect(output).toHaveLength(2);
        expect(output[0].sourceRect.x + output[0].sourceRect.width).toBeLessThan(185);
        expect(output[1].sourceRect.x).toBeGreaterThan(180);
        const otherMarker = rect(145, 100, 15);
        expect(regions(group([block(-1, first), block(-1, marker, '(1)'), block(-1, otherMarker, '□'), block(-1, second)],
            [image('first', first), image('two-markers', wideCrop), image('second', second)]))).toHaveLength(2);
    });

    it('retains a diagram return path near the confirmed component without using paths alone to create or join images', () => {
        const a = rect(100, 200, 20), b = rect(100, 230, 20);
        const paths = [{...rect(100, 242, 20, 0)}, {...rect(122, 200, 0, 42)}, {...rect(100, 242, 0, 0)},
            {...rect(NaN, 200, 10, 0)}, {...rect(100, 200, -1, 0)}, {...rect(100, 200, 0, -1)},
            {...rect(0, 242, 600, 0)}, {...rect(100, 260, 20, 0)}, {...rect(140, 200, 0, 42)}, {...rect(100, 190, 20, 0)}];
        const output = regions(group([block(-1, a), block(-1, b)], [image('a', a), image('b', b)], {layoutBoundaries: paths}));
        expect(output).toHaveLength(1); expect(output[0].sourceRect.x).toBeGreaterThan(90);
        expect(output[0].sourceRect.x + output[0].sourceRect.width).toBeGreaterThanOrEqual(122);
        expect(output[0].sourceRect.y + output[0].sourceRect.height).toBeGreaterThanOrEqual(242);
        expect(output[0].sourceRect.y).toBeGreaterThan(190); expect(output[0].sourceRect.height).toBeLessThan(55);
        expect(group([], [], {layoutBoundaries: paths})).toEqual([]);
        const distant = rect(300, 230, 20);
        expect(regions(group([block(-1, a), block(-1, distant)], [image('a', a), image('d', distant)], {layoutBoundaries: [rect(100, 205, 220, 0)]}))).toHaveLength(2);
    });

    it('checks graphic expansion and exterior padding against nearby prose lines', () => {
        const a = rect(100, 200, 20), b = rect(100, 230, 20), prose = rect(100, 241, 20, 2);
        const target = text(0, prose);
        const output = regions(group([block(-1, a), block(-1, b), block(0, prose, 'prose', 'text')], [image('a', a), image('b', b), target], {layoutBoundaries: [rect(100, 242, 20, 0)]}));
        expect(output).toHaveLength(1); expect(output[0].sourceRect.y + output[0].sourceRect.height).toBeLessThan(241);
        const sides = [rect(94, 200, 2, 40), rect(124, 200, 2, 40), rect(100, 194, 20, 2)];
        const bounded = regions(group([block(-1, a), block(-1, b), ...sides.map((r, i) => block(i, r, 'outside', 'text'))],
            [image('a', a), image('b', b), ...sides.map((r, i) => text(i, r))]))[0].sourceRect;
        expect(bounded.x).toBeGreaterThan(96); expect(bounded.x + bounded.width).toBeLessThan(124); expect(bounded.y).toBeGreaterThan(196);
    });

    it('preserves invalid-region fallback and malformed text instead of allowing invalid geometry to bridge components', () => {
        const a = rect(40, 100), invalid = rect(NaN, 105), b = rect(400, 100);
        const entries = [image('a', a), image('invalid', invalid), image('b', b), text(0, rect(Infinity, 110))];
        const output = group([block(-1, a), block(-1, b), block(0, rect(Infinity, 110), 'bad', 'text')], entries);
        expect(regions(output)).toHaveLength(3); expect(output).toContain(entries[3]); expect(regions(output).find(e => e.id === 'invalid')!.sourceRect.x).toBeNaN();
        expect(regions(group([block(-1, a, 'x', 'formula', {fontSize: NaN})], [image('a', a)]))[0].sourceRect.width).toBeGreaterThan(40);
    });

    it('uses canonical rotated page bounds for optional padding and leaves legacy geometry without corridor evidence in its slot', () => {
        const edge = rect(590, 790, 10, 10);
        const output = regions(group([block(-1, edge)], [image('edge', edge)], {rotation: 90, width: 800, height: 600}))[0];
        expect(output.sourceRect.x + output.sourceRect.width).toBe(600); expect(output.sourceRect.y + output.sourceRect.height).toBe(800);
        const first = text(0, rect(20, 20)), last = text(1, rect(20, 70)), legacy = image('legacy', rect(300, 50), 'figure');
        expect(group([], [first, legacy, last])).toEqual([first, legacy, last]);
    });

    it('positions a diagram before the next short proof in its surrounding prose corridor without exchanging any text', () => {
        const before = text(0, rect(20, 60, 500, 30)), proof = text(1, rect(20, 170, 90, 12)), after = text(2, rect(20, 240, 500, 30));
        const a = rect(250, 110), b = rect(250, 140);
        const blocks = [block(0, before.sourceRect, 'before', 'text', {lineCount: 2}), block(1, proof.sourceRect, 'Proof.', 'text'), block(2, after.sourceRect, 'after', 'text', {lineCount: 2}), block(-1, a), block(-1, b)];
        const output = group(blocks, [before, proof, image('a', a), image('b', b), after]);
        expect(output.filter(e => e.kind === 'text')).toEqual([before, proof, after]);
        expect(output.indexOf(regions(output)[0])).toBe(1);
    });

    it('does not use standalone source-control regions as bridges between ordinary paragraphs', () => {
        const first = rect(40, 100), second = rect(40, 120);
        const output = regions(group([block(0, first, '\u0093', 'text'), block(1, second, '\u0094', 'text')], [image('c0', first, 'text', [0]), image('c1', second, 'text', [1])], {}, [0, 1]));
        expect(output).toHaveLength(2); expect(output[0].sourceRect).toEqual(first); expect(output[1].sourceRect).toEqual(second);
        for (const second of [rect(40, 105), rect(45, 102, 20, 5)]) {
            expect(regions(group([block(0, first, '\u0093', 'text'), block(1, second, '\u0094', 'text')], [image('c0', first, 'text', [0]), image('c1', second, 'text', [1])], {}, [0, 1]))).toHaveLength(2);
        }
    });

    it('continues a supported column gutter through the blank formula band between corresponding paragraph pairs', () => {
        const paragraphs = [rect(20, 20, 200, 30), rect(250, 20, 200, 30), rect(20, 150, 200, 30), rect(250, 150, 200, 30)];
        const formula = rect(160, 100, 20), number = rect(420, 100, 15);
        const output = group([...paragraphs.map((r, i) => block(i, r, 'column', 'text', {lineCount: 2})), block(-1, formula), block(-1, number, '(8)')],
            [...paragraphs.map((r, i) => text(i, r)), image('m', formula), image('n', number)]);
        expect(regions(output)).toHaveLength(2); expect(output.filter(e => e.kind === 'text').map(e => e.segmentIndex)).toEqual([0, 1, 2, 3]);
        // 不同横向范围的空白带不连成一个猜测的整页竖带。
        const elsewhere = [rect(50, 200, 200, 30), rect(400, 200, 150, 30)];
        expect(group([...paragraphs.slice(0, 2).map((r, i) => block(i, r, 'column', 'text', {lineCount: 2})), ...elsewhere.map((r, i) => block(i + 2, r, 'different', 'text', {lineCount: 2})), block(-1, formula), block(-1, number, '(8)')],
            [...paragraphs.slice(0, 2).map((r, i) => text(i, r)), ...elsewhere.map((r, i) => text(i + 2, r)), image('m', formula), image('n', number)]).filter(e => e.kind === 'text')).toHaveLength(4);
    });

    it('does not use a terminal number already inside a broad source crop as condition baseline evidence', () => {
        const subject = rect(40, 100, 40, 30), embeddedNumber = rect(400, 110, 15, 10), nextNumber = rect(500, 110, 15, 10), condition = rect(420, 100, 40, 20);
        const broad = rect(40, 100, 375, 30), target = text(0, condition);
        const output = group([block(-1, subject, 'subject', 'formula', {lines: [{...subject, text: 'subject', baseline: 108}]}), block(-1, embeddedNumber, '(1)'),
            block(-1, nextNumber, '(2)'), block(0, condition, 'unaligned', 'text', {lines: [{...condition, text: 'unaligned', baseline: 118}]})],
            [image('existing-crop', broad), target, image('n', nextNumber)]);
        expect(regions(output)).toHaveLength(2); expect(output).toContain(target);
    });

    it('keeps missing math-line evidence and malformed ordinary lines conservative and preserves coincident crop order', () => {
        const subject = rect(40, 100, 40, 30), number = rect(400, 110, 15, 10), condition = rect(90, 100, 200, 20);
        const output = group([block(-1, subject, 'subject', 'formula', {lines: undefined}), block(-1, number, '(1)'), block(0, condition, 'condition', 'text')],
            [image('m', subject), text(0, condition), image('n', number)]);
        expect(regions(output)).toHaveLength(2);
        const invalidMathLine = group([block(-1, subject, 'subject', 'formula', {lines: [{...rect(NaN, 100), text: 'invalid math geometry', baseline: 108}]}),
            block(-1, number, '(1)'), block(0, condition, 'condition', 'text')], [image('m', subject), text(0, condition), image('n', number)]);
        expect(regions(invalidMathLine)).toHaveLength(2);
        const escapedMathLine = group([block(-1, subject, 'subject', 'formula', {lines: [{...rect(300, 100), text: 'escaped math line', baseline: 108}]}),
            block(-1, number, '(1)'), block(0, condition, 'condition', 'text')], [image('m', subject), text(0, condition), image('n', number)]);
        expect(regions(escapedMathLine)).toHaveLength(2);
        const badLines = block(1, rect(100, 150, 200, 20), 'bad line', 'text', {lines: [{...rect(NaN, 150), text: 'invalid'}]});
        expect(group([block(-1, subject), badLines], [image('m', subject), text(1, badLines)]).filter(e => e.kind === 'text')).toHaveLength(1);
        const prose = rect(20, 90, 300, 100);
        const coincident = group([block(0, prose, 'overlapping prose', 'text', {lines: undefined})],
            [image('first', rect(100, 100, 20)), image('second', rect(100, 100, 30)), text(0, prose)]);
        expect(regions(coincident).map(entry => entry.id)).toEqual(['first', 'second']); expect(coincident.at(-1)?.kind).toBe('text');
    });

    it('uses valid paragraph bounds as a barrier when any source line has invalid geometry', () => {
        const first = rect(40, 100, 20), second = rect(80, 100, 20), prose = rect(65, 100, 10);
        for (const lines of [[{...rect(NaN, 100), text: 'invalid'}], [{...rect(65, 100, 2), text: 'partial'}, {...rect(70, NaN, 2), text: 'invalid'}]]) {
            const target = text(0, prose), original = [image('a', first), target, image('b', second)];
            const output = group([block(-1, first), block(-1, second), block(0, prose, 'ordinary text', 'text', {lines})], original);
            expect(regions(output)).toHaveLength(2); expect(output.filter(e => e.kind === 'text')).toEqual([target]);
            expect(regions(output).every(entry => entry.sourceRect.width < 30)).toBe(true);
        }
    });
});
