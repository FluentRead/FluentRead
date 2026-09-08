import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_FREE_TRANSLATION_ORDER, FREE_TRANSLATION_PROVIDERS,
    normalizeFreeTranslationOrder, normalizeFreeTranslationTimeoutMs, normalizeFreeTranslationCooldownMs,
    normalizeMyMemoryEmail,
} from '@/src/core/config/freeTranslation';
import {sanitizeConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {buildConfigDiff} from '@/src/core/config/diff';

describe('keyless free translation configuration', () => {
    it('migrates old settings while keeping explicit opt-outs and never automatically adding paid-capable accounts', () => {
        expect(new Config().freeTranslationOrder).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
        for (const value of [undefined, null, 'myMemory', [], ['untrusted', 42]]) {
            expect(normalizeFreeTranslationOrder(value)).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
        }
        expect(normalizeFreeTranslationOrder(['myMemory', 'google', 'myMemory', {}, 'unknown']))
            .toEqual(['myMemory', 'google']);
        expect(normalizeConfig({freeTranslationOrder: ['myMemory']}).freeTranslationOrder).toEqual(['myMemory']);
        expect(FREE_TRANSLATION_PROVIDERS.find(item => item.id === 'myMemory')?.official).toBe(true);
        expect(FREE_TRANSLATION_PROVIDERS.map(item => item.id)).toEqual(['microsoft', 'deeplx', 'google', 'myMemory', 'apertium']);
        expect(normalizeFreeTranslationOrder(['azureTranslator', 'myMemory', 'deepL', 'openai'])).toEqual(['myMemory']);
        expect(normalizeFreeTranslationOrder(['azureTranslator', 'deepL'])).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
    });

    it('bounds timing and validates optional contact fields', () => {
        for (const value of [undefined, null, NaN, Infinity, '2000']) {
            expect(normalizeFreeTranslationTimeoutMs(value)).toBe(5000);
            expect(normalizeFreeTranslationCooldownMs(value)).toBe(60000);
        }
        expect(normalizeFreeTranslationTimeoutMs(-1)).toBe(1000);
        expect(normalizeFreeTranslationTimeoutMs(16000)).toBe(15000);
        expect(normalizeFreeTranslationTimeoutMs(2345.6)).toBe(2345);
        expect(normalizeFreeTranslationCooldownMs(900000)).toBe(300000);
        expect(normalizeFreeTranslationCooldownMs(500)).toBe(1000);
        expect(normalizeMyMemoryEmail(' contact@example.test ')).toBe('contact@example.test');
        for (const value of [null, '', 'invalid', 'a\n@b.test', `${'a'.repeat(250)}@b.test`]) {
            expect(normalizeMyMemoryEmail(value)).toBe('');
        }
    });

    it('round-trips anonymous policy and optional email while excluding existing service keys from exports', () => {
        const config = normalizeConfig({...new Config(), service: 'freeTranslation',
            freeTranslationOrder: ['myMemory', 'google'], freeTranslationTimeoutMs: 3000,
            freeTranslationCooldownMs: 120000, myMemoryEmail: 'contact@example.test',
            token: {deepL: 'private-test-key'}});
        const exported = sanitizeConfigForExport(config);
        expect(JSON.stringify(exported)).not.toContain('private-test-key');
        expect(prepareConfigForImport(exported, new Config())).toMatchObject({
            service: 'freeTranslation', freeTranslationOrder: ['myMemory', 'google'],
            freeTranslationTimeoutMs: 3000, freeTranslationCooldownMs: 120000,
            myMemoryEmail: 'contact@example.test',
        });
        expect(getMissingCredentialMessage('freeTranslation', new Config())).toBeNull();
        expect(getMissingCredentialMessage('myMemory', new Config())).toBeNull();
    });

    it('shows readable ordered providers and timing in configuration history', () => {
        const result = buildConfigDiff({freeTranslationOrder: ['microsoft'], freeTranslationTimeoutMs: 5000,
            freeTranslationCooldownMs: 60000, myMemoryEmail: ''}, {
            freeTranslationOrder: ['myMemory', 'google'], freeTranslationTimeoutMs: 3000,
            freeTranslationCooldownMs: 120000, myMemoryEmail: 'contact@example.test',
        });
        const changes = result.groups.find(item => item.id === 'translationServices')!.changes;
        expect(changes).toHaveLength(4);
        expect(changes.find(item => item.key === 'freeTranslationOrder')?.after).toContain('MyMemory');
        expect(changes.find(item => item.key === 'freeTranslationTimeoutMs')?.after).toContain('3000');
        expect(buildConfigDiff({freeTranslationOrder: null}, {freeTranslationOrder: 'invalid'}).changeCount).toBe(1);
    });
});
