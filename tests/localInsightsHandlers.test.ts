import {describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    modelUsage: {
        getDashboard: vi.fn(),
        getRequestLog: vi.fn(),
        exportData: vi.fn(),
        importData: vi.fn(),
        clear: vi.fn(async () => undefined),
    },
    translationStats: {
        getDashboard: vi.fn(),
        getRequestLog: vi.fn(),
        clear: vi.fn(async () => undefined),
    },
}));

vi.mock('@/src/platform/storage/modelUsageRepository', () => ({modelUsageRepository: mocks.modelUsage}));
vi.mock('@/src/platform/storage/translationStatsRepository', () => ({translationStatsRepository: mocks.translationStats}));

import {createLocalInsightsHandlers} from '@/src/app/background/localInsightsHandlers';

describe('本机统计后台 handler 组合', () => {
    it('模型用量与翻译统计共用设置页来源校验并注入各自仓库', async () => {
        const isOptionsUrl = vi.fn((url: string) => url.startsWith('chrome-extension://id/options.html'));
        const handlers = createLocalInsightsHandlers(isOptionsUrl);
        expect(handlers.map((handler) => handler.type)).toEqual(['modelUsage', 'translationStats']);

        const trusted = {sender: {url: 'chrome-extension://id/options.html'}};
        const reset = (type: string): {type: string} => ({type, action: 'reset'}) as {type: string};
        await expect(handlers[0].handle(reset('modelUsage'), trusted)).resolves.toEqual({success: true, data: {cleared: true}});
        await expect(handlers[1].handle(reset('translationStats'), trusted)).resolves.toEqual({success: true, data: {cleared: true}});
        expect(mocks.modelUsage.clear).toHaveBeenCalledOnce();
        expect(mocks.translationStats.clear).toHaveBeenCalledOnce();

        await expect(handlers[1].handle(reset('translationStats'), {sender: {url: 'https://example.com'}}))
            .resolves.toMatchObject({success: false});
        expect(isOptionsUrl).toHaveBeenCalledWith('https://example.com');
    });
});
