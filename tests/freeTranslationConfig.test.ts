import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_FREE_TRANSLATION_ORDER, FREE_TRANSLATION_PROVIDERS,
    normalizeFreeTranslationOrder, normalizeFreeTranslationTimeoutMs, normalizeFreeTranslationCooldownMs,
    normalizeMyMemoryEmail, normalizeFreeTranslationMode,
} from '@/src/core/config/freeTranslation';
import {prepareConfigForExport, prepareConfigForImport} from '@/src/core/config/transfer';
import {sanitizeConfigCredentials} from '@/src/core/config/credentials';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {buildConfigDiff} from '@/src/core/config/diff';

describe('keyless free translation configuration', () => {
    it('migrates old settings while keeping explicit opt-outs and never automatically adding paid-capable accounts', () => {
        expect(new Config().freeTranslationOrder).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
        expect(new Config().freeTranslationOrder).toEqual(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id));
        for (const value of [undefined, null, 'myMemory', [], ['untrusted', 42]]) {
            expect(normalizeFreeTranslationOrder(value)).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
        }
        expect(normalizeFreeTranslationOrder(['myMemory', 'google', 'myMemory', {}, 'unknown']))
            .toEqual(['myMemory', 'google']);
        expect(normalizeConfig({freeTranslationOrder: ['myMemory']}).freeTranslationOrder).toEqual(['bilibiliFree', 'myMemory']);
        expect(FREE_TRANSLATION_PROVIDERS.find(item => item.id === 'myMemory')?.official).toBe(true);
        expect(FREE_TRANSLATION_PROVIDERS.map(item => item.id)).toEqual(['microsoft', 'bilibiliFree', 'transmart', 'volcengineFree', 'google', 'youdaoFree', 'icibaFree', 'yandexFree', 'myMemory', 'sogouFree', 'reversoFree', 'apertiumFree', 'alibabaFree', 'modernMtFree', 'laraFree', 'lingvanexFree']);
        expect(normalizeFreeTranslationOrder(['azureTranslator', 'myMemory', 'deepL', 'openai'])).toEqual(['myMemory']);
        expect(normalizeFreeTranslationOrder(['azureTranslator', 'deepL'])).toEqual(DEFAULT_FREE_TRANSLATION_ORDER);
    });

    it('移除第三方旧节点并保留用户已选择的官方节点和独立 DeepLX 配置', () => {
        expect(FREE_TRANSLATION_PROVIDERS.every(provider => provider.official)).toBe(true);
        expect(normalizeFreeTranslationOrder(['deeplx', 'lingvaFree', 'google'])).toEqual(['google']);
        const enabled = normalizeConfig({freeTranslationOrder: ['deeplx', 'google'], deeplx: 'https://user.example/translate'});
        expect(enabled.freeTranslationOrder).toEqual(['bilibiliFree', 'google']);
        const imported = prepareConfigForImport(prepareConfigForExport(enabled), new Config());
        expect(imported.freeTranslationOrder).toEqual(['bilibiliFree', 'google']);
        expect(imported.deeplx).toBe('https://user.example/translate');
        expect(normalizeFreeTranslationOrder(['alibabaFree'])).toEqual(['alibabaFree']);
    });

    it('旧配置只补一次 B站默认节点，并保留其他选择与顺序', () => {
        const migrated = normalizeConfig({freeTranslationOrder: ['google', 'myMemory']});
        expect(migrated.freeTranslationOrder).toEqual(['bilibiliFree', 'google', 'myMemory']);
        expect(migrated.freeTranslationBilibiliDefaultApplied).toBe(true);
        expect(normalizeConfig(migrated).freeTranslationOrder).toEqual(migrated.freeTranslationOrder);
        expect(normalizeConfig({freeTranslationOrder: ['bilibiliFree', 'google']}).freeTranslationOrder)
            .toEqual(['bilibiliFree', 'google']);
    });

    it('首次升级后手动关闭 B站，在重读、导出和恢复时保持关闭', () => {
        const migrated = normalizeConfig({freeTranslationOrder: ['google']});
        migrated.freeTranslationOrder = ['google'];
        const reloaded = normalizeConfig(JSON.parse(JSON.stringify(migrated)));
        expect(reloaded.freeTranslationOrder).toEqual(['google']);
        const restored = prepareConfigForImport(prepareConfigForExport(reloaded), new Config());
        expect(restored.freeTranslationOrder).toEqual(['google']);
        expect(restored.freeTranslationBilibiliDefaultApplied).toBe(true);
        expect(buildConfigDiff({freeTranslationBilibiliDefaultApplied: false},
            {freeTranslationBilibiliDefaultApplied: true}).changeCount).toBe(0);
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
        // 不含凭据的配置文件仍需完整保留匿名额度策略与可选邮箱。
        const exported = sanitizeConfigCredentials(JSON.parse(JSON.stringify(config)));
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
        const officialChanges = buildConfigDiff({freeTranslationOrder: ['modernMtFree']}, {freeTranslationOrder: ['alibabaFree']});
        expect(officialChanges.groups[0]!.changes[0]!.after).toContain('阿里翻译');
        expect(buildConfigDiff({freeTranslationOrder: null}, {freeTranslationOrder: 'invalid'}).changeCount).toBe(1);
    });
});

 it('defaults to Microsoft-first balanced policy and rejects user supplied weights', () => {
    expect(new Config().freeTranslationMode).toBe('balanced');
    expect(new Config()).not.toHaveProperty('freeTranslationWeights');
    expect(DEFAULT_FREE_TRANSLATION_ORDER.slice(0, 2)).toEqual(['microsoft', 'bilibiliFree']);
    expect(normalizeConfig({freeTranslationOrder: ['microsoft', 'google']}).freeTranslationOrder).toEqual(['microsoft', 'bilibiliFree', 'google']);
    expect(normalizeFreeTranslationMode('sequential')).toBe('sequential');
    expect(normalizeFreeTranslationMode('invalid')).toBe('balanced');
    const supplied = {freeTranslationMode: 'sequential', freeTranslationWeights: {microsoft: 0, google: 999999}};
    const normalized = normalizeConfig(supplied);
    expect(normalized.freeTranslationMode).toBe('sequential');
    expect(normalized).not.toHaveProperty('freeTranslationWeights');
    expect(prepareConfigForExport(normalized)).not.toHaveProperty('freeTranslationWeights');
    const changes = buildConfigDiff({freeTranslationMode: 'balanced'}, {freeTranslationMode: 'sequential'});
    expect(changes.changeCount).toBe(1);
});
