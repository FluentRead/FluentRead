import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    captureGeneration: vi.fn(() => 11),
    recordMany: vi.fn(async (_events: unknown, _generation: number) => 1),
    resolveConfiguredModel: vi.fn((_selected?: string, _custom?: string) => 'resolved-model'),
    runConnectionTest: vi.fn(async (_service: string, _options: any) => ({durationMs: 25})),
    getFreeTranslationWeightSnapshot: vi.fn(async () => ({total: 100, observedAt: 1, entries: []})),
}));

vi.mock('@/src/providers/translation/connectionTest', () => ({
    formatConnectionTestError: vi.fn(),
    runTranslationServiceConnectionTest: mocks.runConnectionTest,
}));
vi.mock('@/src/providers/translation/free-translation', () => ({
    getFreeTranslationWeightSnapshot: mocks.getFreeTranslationWeightSnapshot,
}));
vi.mock('@/src/app/translation/runtime', () => ({
    translationRequestScheduler: {
        schedule: vi.fn(async (task: (lease: any) => Promise<unknown>) => task({holdUntil: vi.fn()})),
    },
}));
vi.mock('@/src/services/translation/broker', () => ({
    resolveTranslationRequestModel: vi.fn(() => 'resolved-model'),
}));
vi.mock('@/src/services/config/store', () => ({
    config: {
        model: {moonshot: 'kimi-k2.6'},
        customModel: {moonshot: ''},
    },
}));
vi.mock('@/src/core/config/catalog', () => ({
    resolveConfiguredModel: mocks.resolveConfiguredModel,
    servicesType: {isAiSdk: vi.fn(() => false)},
}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({
    modelUsageRepository: {
        captureGeneration: mocks.captureGeneration,
        recordMany: mocks.recordMany,
    },
}));

import {getFreeTranslationWeightSnapshot, runTranslationServiceConnectionTestWithUsage} from '@/src/app/background/providerRuntime';

describe('background provider runtime', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('captures reset generation before connection test and injects model usage persistence', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const events = [{serviceId: 'moonshot'}] as never;

        await expect(runTranslationServiceConnectionTestWithUsage('moonshot'))
            .resolves.toEqual({durationMs: 25});

        expect(mocks.captureGeneration).toHaveBeenCalledOnce();
        const options = mocks.runConnectionTest.mock.calls[0][1];
        expect(options.configuredModel).toBe('resolved-model');
        await options.recordModelUsage(events);
        expect(mocks.recordMany).toHaveBeenCalledWith(events, 11);

        const failure = new Error('usage write failed');
        options.warn('usage warning', failure);
        expect(warn).toHaveBeenCalledWith('usage warning', failure);
        warn.mockRestore();
    });

    it('exposes the provider-owned free translation weight snapshot through the composition root', async () => {
        await expect(getFreeTranslationWeightSnapshot()).resolves.toEqual({total: 100, observedAt: 1, entries: []});
        expect(mocks.getFreeTranslationWeightSnapshot).toHaveBeenCalledOnce();
    });
});
