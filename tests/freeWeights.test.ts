import {describe, expect, it} from 'vitest';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {calculateFreeTranslationWeightSnapshot} from '@/src/services/translation/freeWeights';

type FreeProviderId = typeof FREE_TRANSLATION_PROVIDERS[number]['id'];
const enabledProviderIds: FreeProviderId[] = FREE_TRANSLATION_PROVIDERS.slice(0, 9).map(provider => provider.id);
const enabledProviderSet = new Set<string>(enabledProviderIds);
const entry = (providerId: string, snapshot: ReturnType<typeof calculateFreeTranslationWeightSnapshot>) => {
    const result = snapshot.entries.find(item => item.providerId === providerId);
    expect(result, providerId).toBeDefined();
    return result!;
};

describe('free translation weight snapshots', () => {
    it('normalizes enabled default weights to exactly 100%', () => {
        const snapshot = calculateFreeTranslationWeightSnapshot(enabledProviderIds, [], 1_000);
        const enabled = snapshot.entries.filter(item => enabledProviderSet.has(item.providerId));

        expect(snapshot.total).toBe(100);
        expect(enabled.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
        expect(entry('microsoft', snapshot)).toMatchObject({weight: 20.8, status: 'ready'});
        expect(entry('sogouFree', snapshot)).toMatchObject({weight: 0, status: 'disabled'});
        expect(entry('microsoft', snapshot).weight.toString()).toMatch(/^\d+\.\d$/u);
    });

    it('drops a failed service to zero during its cooldown and renormalizes the rest', () => {
        const now = 10_000;
        const snapshot = calculateFreeTranslationWeightSnapshot(enabledProviderIds, [{
            providerId: 'microsoft', retryAt: now + 1_000, failures: 1, category: 'unavailable',
        }], now);
        const enabled = snapshot.entries.filter(item => enabledProviderSet.has(item.providerId));

        expect(snapshot.total).toBe(100);
        expect(entry('microsoft', snapshot)).toMatchObject({weight: 0, status: 'cooling', retryAt: now + 1_000});
        expect(enabled.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
        expect(entry('transmart', snapshot).weight).toBeGreaterThan(0);
    });

    it('gives a cooled service a lower recovering weight after the probe window', () => {
        const now = 20_000;
        const snapshot = calculateFreeTranslationWeightSnapshot(enabledProviderIds, [{
            providerId: 'microsoft', retryAt: 0, failures: 1, category: 'unavailable',
            performance: {reliability: 0.75, latencyMs: 1_000, observedAt: now},
        }], now);

        expect(entry('microsoft', snapshot)).toMatchObject({status: 'recovering'});
        expect(entry('microsoft', snapshot).weight).toBeLessThan(20.8);
        expect(entry('transmart', snapshot).weight).toBeGreaterThan(entry('microsoft', snapshot).weight);
        expect(snapshot.entries.filter(item => enabledProviderSet.has(item.providerId)).reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    });

    it('reports no allocation when every enabled service is cooling', () => {
        const now = 30_000;
        const health = enabledProviderIds.map(providerId => ({
            providerId, retryAt: now + 1_000, failures: 1, category: 'unavailable' as const,
        }));
        const snapshot = calculateFreeTranslationWeightSnapshot(enabledProviderIds, health, now);

        expect(snapshot.total).toBe(0);
        expect(snapshot.entries.filter(item => enabledProviderSet.has(item.providerId)).every(item => item.weight === 0 && item.status === 'cooling')).toBe(true);
    });

    it('decays legacy failure records without performance by bounded failure counts after cooldown', () => {
        const now = 40_000;
        const weightFor = (failures: number) => entry('microsoft', calculateFreeTranslationWeightSnapshot(enabledProviderIds, [{
            providerId: 'microsoft', retryAt: now - 1, failures, category: 'unavailable',
        }], now));
        const healthy = entry('microsoft', calculateFreeTranslationWeightSnapshot(enabledProviderIds, [], now)).weight;

        expect(weightFor(1)).toMatchObject({status: 'recovering'});
        expect(weightFor(1).weight).toBeLessThan(healthy);
        // 连续失败越多权重越低，但不低于默认权重的 10%；非整数计数视为无效，不制造额外惩罚。
        expect(weightFor(4).weight).toBeLessThan(weightFor(1).weight);
        expect(weightFor(100).weight).toBe(weightFor(4).weight);
        expect(weightFor(1.5)).toMatchObject({status: 'recovering'});
        expect(weightFor(1.5).weight).toBe(healthy);
    });

    it('keeps a fully reliable or performance-free healthy record ready', () => {
        const now = 50_000;
        const snapshot = calculateFreeTranslationWeightSnapshot(enabledProviderIds, [
            {providerId: 'microsoft', retryAt: 0, failures: 0, category: 'unavailable', performance: {reliability: 1, latencyMs: 1_000, observedAt: now}},
            {providerId: 'google', retryAt: 0, failures: 0, category: 'unavailable'},
            {providerId: 'myMemory', retryAt: 0, failures: 0, category: 'unavailable', performance: {reliability: 0.9, latencyMs: 1_000, observedAt: now}},
        ], now);

        expect(entry('microsoft', snapshot).status).toBe('ready');
        expect(entry('google', snapshot).status).toBe('ready');
        expect(entry('myMemory', snapshot).status).toBe('recovering');
    });
});
