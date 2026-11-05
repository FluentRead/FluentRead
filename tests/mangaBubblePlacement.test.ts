import {describe, expect, it} from 'vitest';
import {bindMangaBubblePlacements, getMangaBubblePlacement, recordMangaBubblePlacement} from '@/src/features/image-translation/services/mangaBubblePlacement';
import type {MangaRegion} from '@/src/features/image-translation/services/mangaRegions';

const image = 'data:image/png;base64,same-original', width = 400, height = 300;
const owner = () => ({x0: 20, y0: 20, x1: 180, y1: 160});
const region = (): MangaRegion => ({text: 'SOURCE TEXT', fontSize: 16, bbox: {x0: 40, y0: 50, x1: 140, y1: 80}, sourceBoxes: [{x0: 40, y0: 50, x1: 140, y1: 80}]});
function recorded(line = region()) {recordMangaBubblePlacement(line, owner(), width, height);return line;}
function bound(line = recorded()) {bindMangaBubblePlacements([line], image, width, height);return line;}
const get = (line: MangaRegion) => getMangaBubblePlacement(line, image, width, height);

describe('private manga bubble placement hints', () => {
    it('binds the actual region without modifying it and isolates the immutable owner copy', () => {
        const line = region(), originalOwner = owner(), before = JSON.stringify(line);
        Object.freeze(line.bbox);Object.freeze(line.sourceBoxes![0]);Object.freeze(line.sourceBoxes);Object.freeze(line);
        recordMangaBubblePlacement(line, originalOwner, width, height);
        expect(get(line)).toBeUndefined();
        bindMangaBubblePlacements(Object.freeze([line]), image, width, height);
        const hint = get(line)!;expect(hint).toEqual(originalOwner);expect(hint).not.toBe(originalOwner);expect(Object.isFrozen(hint)).toBe(true);
        originalOwner.x0 = 19;expect(get(line)).toBe(hint);expect(hint.x0).toBe(20);expect(JSON.stringify(line)).toBe(before);
    });
    it('supports the saved fractional source geometry in its integer physical bubble without rounding it', () => {
        const line: MangaRegion = {text: "AND IT'DBEEVEN BETTERWITHA LITTLEEXTRA SERVICE!", fontSize: 40 / 3,
            bbox: {x0: 900 + 2 / 3, y0: 733 + 1 / 3, x1: 1032 + 2 / 3, y1: 832 + 1 / 3},
            sourceBoxes: [{x0: 943, y0: 733 + 1 / 3, x1: 989 + 2 / 3, y1: 749 + 1 / 3}, {x0: 911 + 1 / 3, y0: 816 + 2 / 3, x1: 1015, y1: 832 + 1 / 3}]};
        const actualOwner = {x0: 878, y0: 682, x1: 1041, y1: 891}, before = JSON.stringify(line);
        recordMangaBubblePlacement(line, actualOwner, 1139, 1620);bindMangaBubblePlacements([line], image, 1139, 1620);
        expect(getMangaBubblePlacement(line, image, 1139, 1620)).toEqual(actualOwner);expect(JSON.stringify(line)).toBe(before);
    });
    it('keeps same-source record and binding idempotent, including a fresh array of the original region', () => {
        const line = bound(), hint = get(line);
        recordMangaBubblePlacement(line, {...owner()}, width, height);bindMangaBubblePlacements([line, line], image, width, height);
        expect(get(line)).toBe(hint);
    });
    it('does not authorize unrecorded, unbound or cloned regions and does not poison a correct lookup', () => {
        const line = region();bindMangaBubblePlacements([line], image, width, height);expect(get(line)).toBeUndefined();
        recordMangaBubblePlacement(line, owner(), width, height);expect(get(line)).toBeUndefined();bound(line);
        expect(get({...line})).toBeUndefined();expect(get(structuredClone(line))).toBeUndefined();
        expect(getMangaBubblePlacement(line, 'different-source', width, height)).toBeUndefined();
        expect(getMangaBubblePlacement(line, image, width + 1, height)).toBeUndefined();expect(getMangaBubblePlacement(line, image, width, height + 1)).toBeUndefined();
        expect(get(line)).toEqual(owner());
    });
    it.each([undefined, null, false, 1, 'text', [], () => 1])('does not create a record for a non-region value %s', value => {
        recordMangaBubblePlacement(value as never, owner(), width, height);bindMangaBubblePlacements([value as never], image, width, height);
        expect(get(value as never)).toBeUndefined();
    });
    it.each([[NaN, height], [width, NaN], [0, height], [width, 0], [8193, height], [width, 8193], [8192, 8192], [400.5, height]])('rejects invalid page dimensions %s by %s', (w, h) => {
        const line = region();recordMangaBubblePlacement(line, owner(), w, h);bindMangaBubblePlacements([line], image, w, h);
        expect(getMangaBubblePlacement(line, image, w, h)).toBeUndefined();
    });
    it.each([null, [], {x0: NaN, y0: 20, x1: 180, y1: 160}, {x0: 20, y0: NaN, x1: 180, y1: 160},
        {x0: 20, y0: 20, x1: NaN, y1: 160}, {x0: 20, y0: 20, x1: 180, y1: NaN},
        {x0: -1, y0: 20, x1: 180, y1: 160}, {x0: 20, y0: -1, x1: 180, y1: 160},
        {x0: 20, y0: 20, x1: 401, y1: 160}, {x0: 20, y0: 20, x1: 180, y1: 301},
        {x0: 20, y0: 20, x1: 20, y1: 160}, {x0: 20, y0: 20, x1: 180, y1: 20},
        {x0: 20.5, y0: 20, x1: 180, y1: 160}, {x0: 0, y0: 20, x1: 180, y1: 160}, {x0: 20, y0: 0, x1: 180, y1: 160},
        {x0: 20, y0: 20, x1: width, y1: 160}, {x0: 20, y0: 20, x1: 180, y1: height}])('rejects malformed, fractional, edge-clipped or out-of-page owner %s', value => {
        const line = region();recordMangaBubblePlacement(line, value as never, width, height);bound(line);expect(get(line)).toBeUndefined();
    });
    it('permits exactly64KiB of owner plus full halo and refuses the next larger observation', () => {
        const exact = region(), tooLarge = region();
        recordMangaBubblePlacement(exact, {x0: 20, y0: 20, x1: 274, y1: 274}, width, height);
        recordMangaBubblePlacement(tooLarge, {x0: 20, y0: 20, x1: 275, y1: 274}, width, height);
        bound(exact);bound(tooLarge);expect(get(exact)).toEqual({x0: 20, y0: 20, x1: 274, y1: 274});expect(get(tooLarge)).toBeUndefined();
    });
    it.each([
        (r: MangaRegion) => {r.text = 1 as never;}, (r: MangaRegion) => {r.text = '';}, (r: MangaRegion) => {r.text = '  ';},
        (r: MangaRegion) => {r.fontSize = NaN;}, (r: MangaRegion) => {r.fontSize = 0;},
        (r: MangaRegion) => {r.vertical = true;}, (r: MangaRegion) => {r.guardOnly = true;},
        (r: MangaRegion) => {r.bbox = null as never;}, (r: MangaRegion) => {r.bbox.x0 = -1;},
        (r: MangaRegion) => {r.bbox = {x0: 0, y0: 50, x1: 10, y1: 80};}, (r: MangaRegion) => {r.bbox = {x0: 200, y0: 50, x1: 220, y1: 80};},
        (r: MangaRegion) => {r.bbox = {x0: 40, y0: 0, x1: 140, y1: 10};}, (r: MangaRegion) => {r.bbox = {x0: 40, y0: 200, x1: 140, y1: 220};},
        (r: MangaRegion) => {r.sourceBoxes = {} as never;}, (r: MangaRegion) => {r.sourceBoxes = Array(4097).fill(r.bbox);},
        (r: MangaRegion) => {r.sourceBoxes = [null as never];}, (r: MangaRegion) => {r.sourceBoxes![0].x0 = NaN;},
        (r: MangaRegion) => {r.sourceBoxes = [{x0: 200, y0: 50, x1: 220, y1: 80}];},
    ])('refuses malformed, vertical, guard or unrelated source region case %# before binding', mutate => {
        const line = region();mutate(line);recordMangaBubblePlacement(line, owner(), width, height);bound(line);expect(get(line)).toBeUndefined();
    });
    it.each([
        (r: MangaRegion) => {r.text += '!';}, (r: MangaRegion) => {r.fontSize += 1;},
        (r: MangaRegion) => {r.vertical = true;}, (r: MangaRegion) => {r.guardOnly = true;},
        (r: MangaRegion) => {r.bbox = {...r.bbox};}, ...(['x0', 'y0', 'x1', 'y1'] as const).map(key => (r: MangaRegion) => {r.bbox[key] += 1;}),
        (r: MangaRegion) => {r.sourceBoxes = r.sourceBoxes!.slice();}, (r: MangaRegion) => {r.sourceBoxes = undefined;},
        (r: MangaRegion) => {r.sourceBoxes![0] = {...r.sourceBoxes![0]};}, (r: MangaRegion) => {r.sourceBoxes!.push({...r.bbox});},
        ...(['x0', 'y0', 'x1', 'y1'] as const).map(key => (r: MangaRegion) => {r.sourceBoxes![0][key] += 1;}),
    ])('withdraws the adopted hint for changed snapshot or geometry reference case %#', mutate => {
        const line = bound();expect(get(line)).toEqual(owner());mutate(line);expect(get(line)).toBeUndefined();
    });
    it('handles absent and empty source arrays but never inherits a newly attached array', () => {
        const absent = region();delete absent.sourceBoxes;bound(recorded(absent));expect(get(absent)).toEqual(owner());absent.sourceBoxes = [];expect(get(absent)).toBeUndefined();
        const empty = region();empty.sourceBoxes = [];bound(recorded(empty));expect(get(empty)).toEqual(owner());empty.sourceBoxes = [];expect(get(empty)).toBeUndefined();
    });
    it('refuses a sparse source array before recording instead of skipping its missing physical box', () => {
        const line = region();line.sourceBoxes = new Array(2);line.sourceBoxes[1] = {...line.bbox};
        expect(0 in line.sourceBoxes).toBe(false);bound(recorded(line));expect(get(line)).toBeUndefined();
        const undefinedEntry = region();undefinedEntry.sourceBoxes = [undefined as never, {...undefinedEntry.bbox}];
        bound(recorded(undefinedEntry));expect(get(undefinedEntry)).toBeUndefined();
    });
    it('withdraws a bound hint when a source slot is deleted without changing array identity or length', () => {
        const line = bound(), sources = line.sourceBoxes!;expect(get(line)).toEqual(owner());
        Reflect.deleteProperty(sources, '0');expect(line.sourceBoxes).toBe(sources);expect(sources).toHaveLength(1);expect(0 in sources).toBe(false);
        expect(get(line)).toBeUndefined();
    });
    it.each(['source', 'width', 'height', 'empty', 'non-string'] as const)('does not transfer an old region through a different %s binding', mode => {
        const line = bound();bindMangaBubblePlacements([line], mode === 'source' ? 'new-source' : mode === 'empty' ? '' : mode === 'non-string' ? 4 as never : image,
            mode === 'width' ? width + 1 : width, mode === 'height' ? height + 1 : height);
        expect(get(line)).toBeUndefined();expect(getMangaBubblePlacement(line, 'new-source', width, height)).toBeUndefined();
        recordMangaBubblePlacement(line, owner(), width, height);bound(line);expect(get(line)).toBeUndefined();
    });
    it.each(['invalid', 'owner', 'width', 'height', 'snapshot'] as const)('revokes rather than resetting an existing %s record', mode => {
        const line = bound();if (mode === 'snapshot') line.text += '!';
        recordMangaBubblePlacement(line, mode === 'invalid' ? null as never : mode === 'owner' ? {...owner(), x0: 19} : owner(), mode === 'width' ? width + 1 : width, mode === 'height' ? height + 1 : height);
        expect(get(line)).toBeUndefined();
    });
    it('cannot revive observed stale or initially invalid records after values are restored', () => {
        const stale = bound(), originalText = stale.text;stale.text = 'changed';expect(get(stale)).toBeUndefined();stale.text = originalText;recordMangaBubblePlacement(stale, owner(), width, height);bound(stale);expect(get(stale)).toBeUndefined();
        const invalid = region();invalid.fontSize = NaN;recorded(invalid);invalid.fontSize = 16;recorded(invalid);bound(invalid);expect(get(invalid)).toBeUndefined();
    });
    it('rejects pending or already bound snapshots changed before binding', () => {
        for (const line of [recorded(), bound()]) {line.text = 'different';bound(line);expect(get(line)).toBeUndefined();}
    });
});
