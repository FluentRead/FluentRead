import {describe, expect, it} from 'vitest';
import {materialImportCapacity} from '@/src/features/vocabulary/materialImportCapacity';
import {MATERIAL_IMPORT_FRAME_BYTES, MATERIAL_IMPORT_MAX_FRAMES, MATERIAL_IMPORT_MAX_TOTAL_BYTES} from '@/src/features/vocabulary/materialProtocol';

describe('material backup storage estimate', () => {
    it('permits a previously rejected 329 MB manifest when the estimate leaves enough space', () => {
        const capacity = materialImportCapacity({quota: 4_000_000_000, usage: 300_000_000});
        expect(capacity).toBeGreaterThanOrEqual(328_773_783);
        expect(capacity).toBeLessThanOrEqual(MATERIAL_IMPORT_MAX_FRAMES * MATERIAL_IMPORT_FRAME_BYTES);
    });
    it('reserves headroom, rounds conservatively and caps admission at protocol capacity', () => {
        expect(materialImportCapacity({quota: 134_217_740.9, usage: 0.1})).toBe(3);
        expect(materialImportCapacity({quota: 100, usage: 200})).toBe(0);
        expect(materialImportCapacity({quota: Number.MAX_SAFE_INTEGER, usage: 0})).toBe(MATERIAL_IMPORT_MAX_FRAMES * MATERIAL_IMPORT_FRAME_BYTES);
    });
    it.each([undefined, null, 4, {}, {quota: -1, usage: 0}, {quota: 1, usage: -1},
        {quota: NaN, usage: 0}, {quota: 1, usage: Infinity},
        {quota: Number.MAX_SAFE_INTEGER + 1, usage: 0}, {quota: 1, usage: Number.MAX_SAFE_INTEGER + 1},
        {get quota(): never {throw Error('unavailable');}}])('uses the fixed fallback for unavailable or invalid estimates', estimate => {
        expect(materialImportCapacity(estimate)).toBe(MATERIAL_IMPORT_MAX_TOTAL_BYTES);
    });
});
