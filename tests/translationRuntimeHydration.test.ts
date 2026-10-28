import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import type {TranslationProviderRequest, TranslationRequestMessage} from '@/src/services/translation/types';

const flush = async () => {for (let index = 0; index < 40; index++) await Promise.resolve();};

async function runtimeFixture(service = 'freeTranslation', aiRequestTimeoutMs = 120_000) {
    let hydrate!: () => void;
    const ready = new Promise<void>(resolve => {hydrate = resolve;});
    const config = Object.assign(new Config(), {on: true, service, from: 'en', to: 'zh-Hans',
        useCache: false, enableAIContext: false, aiRequestTimeoutMs, translationMaxRetries: 0,
        translationRequestsPerSecond: 0, translationRequestsPerMinute: 0});
    config.token[service] = 'test-key';
    const provider = vi.fn((_request: TranslationProviderRequest) => new Promise<string>(() => {}));
    vi.doMock('@/src/services/config/store', () => ({config, configReady: ready,
        subscribeConfig: (listener: (value: Config) => void) => {listener(config); return () => {};}}));
    vi.doMock('@/src/providers/translation/registry', () => ({translationProviderRegistry: {[service]: provider}}));
    const cache = {setLimits: vi.fn(async () => {}), get: vi.fn(async () => null), set: vi.fn(async () => true),
        clear: vi.fn(async () => {}), cleanup: vi.fn(async () => {}), getStats: vi.fn(async () => ({entries: 2, bytes: 8}))};
    vi.doMock('@/src/services/translation/cache', () => ({buildTranslationCacheKey: JSON.stringify, translationCache: cache}));
    const modelUsage = {captureGeneration: vi.fn(() => 7), recordMany: vi.fn(async () => 1)};
    const translationStats = {captureGeneration: vi.fn(() => 11), record: vi.fn()};
    const getModelUsageRepository = vi.fn(() => modelUsage);
    const getTranslationStatsRepository = vi.fn(() => translationStats);
    vi.doMock('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository}));
    vi.doMock('@/src/platform/storage/translationStatsRepository', () => ({getTranslationStatsRepository}));
    const runtime = await import('@/src/app/translation/runtime');
    const {markTranslationRemainingBudget} = await import('@/src/services/translation/requestSnapshot');
    return {runtime, provider, hydrate, cache, markTranslationRemainingBudget, modelUsage, translationStats,
        getModelUsageRepository, getTranslationStatsRepository};
}

beforeEach(() => {vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(0);});
afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    for (const module of ['@/src/services/config/store', '@/src/providers/translation/registry',
        '@/src/services/translation/cache', '@/src/platform/storage/modelUsageRepository',
        '@/src/platform/storage/translationStatsRepository']) vi.doUnmock(module);
});

describe('实际翻译 composition 的水合与总截止时间', () => {
    it('公开清理与容量查询等待配置阈值水合，启动维护失败后查询重试当前阈值', async () => {
        const f = await runtimeFixture();
        const failure = new Error('controlled cache policy failure');
        f.cache.setLimits.mockRejectedValueOnce(failure);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const cleanup = f.runtime.cleanupTranslationCache();
        await flush();
        expect(f.cache.cleanup).not.toHaveBeenCalled();
        f.hydrate();
        await cleanup;
        expect(warn).toHaveBeenCalledWith('[FluentRead] translation cache policy failed:', failure);
        expect(f.cache.cleanup).toHaveBeenCalledOnce();
        await expect(f.runtime.getTranslationCacheStats()).resolves.toEqual({entries: 2, bytes: 8});
        expect(f.cache.setLimits).toHaveBeenCalledTimes(2);
        expect(f.cache.getStats).toHaveBeenCalledOnce();
    });

    it.each([
        ['chrome', 'chrome-extension:', true], ['firefox', 'moz-extension:', true],
        ['safari', 'safari-web-extension:', true], ['chrome', 'https:', false],
        ['chrome', undefined, false], ['userscript', 'https:', false],
        ['userscript', 'chrome-extension:', false],
    ] as const)('%s / %s 只在实际扩展入口持有统计仓库', async (browser, protocol, records) => {
        vi.stubEnv('BROWSER', browser); vi.stubGlobal('location', protocol ? {protocol} : undefined);
        const f = await runtimeFixture('gemini');
        const {reportTranslationModelUsage} = await import('@/src/services/translation/requestSnapshot');
        f.provider.mockImplementation(async request => {
            reportTranslationModelUsage(request, {usageAvailability: 'reported', inputTokens: 4, outputTokens: 2, totalTokens: 6});
            return '真实翻译结果';
        });
        f.hydrate();
        await expect(f.runtime.translateWithCache({origin: 'Readable English source text.'})).resolves.toBe('真实翻译结果');
        if (records) {
            expect(f.modelUsage.captureGeneration).toHaveBeenCalledOnce();
            expect(f.modelUsage.recordMany).toHaveBeenCalledWith([expect.objectContaining({inputTokens: 4, outputTokens: 2})], 7);
            expect(f.translationStats.captureGeneration).toHaveBeenCalledOnce();
            expect(f.translationStats.record).toHaveBeenCalledWith(expect.objectContaining({outcome: 'success'}), 11);
        } else {
            expect(f.getModelUsageRepository).not.toHaveBeenCalled();
            expect(f.getTranslationStatsRepository).not.toHaveBeenCalled();
        }
    });

    it('事件循环尚未执行超时回调时，迟到水合仍检查绝对截止时间', async () => {
        const f = await runtimeFixture();
        const result = f.runtime.translateWithCache(f.markTranslationRemainingBudget({
            origin: 'Readable English source text.', requestTimeoutMs: 100,
        }));
        const failure = result.catch(error => error);
        vi.setSystemTime(101);
        f.hydrate();
        expect(await failure).toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(f.provider).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['remaining', 'external', 'ai-default'] as const)('%s 水合耗时只扣除一次，provider 沿用入口绝对截止时间', async kind => {
        const f = await runtimeFixture(kind === 'ai-default' ? 'gemini' : 'freeTranslation', 10_000);
        const budget = kind === 'remaining' ? 100 : kind === 'external' ? 1_000 : 10_000;
        const request: TranslationRequestMessage = {origin: 'Readable English source text.', useCache: false};
        if (kind === 'remaining') f.markTranslationRemainingBudget(Object.assign(request, {requestTimeoutMs: budget}));
        if (kind === 'external') request.requestTimeoutMs = 1;
        const result = f.runtime.translateWithCache(request);
        const failure = result.catch(error => error);
        await vi.advanceTimersByTimeAsync(budget - 10);
        f.hydrate(); await flush();
        expect(f.provider).toHaveBeenCalledOnce();
        expect(f.provider.mock.calls[0][0].requestTimeoutMs).toBe(10);
        const signal = f.provider.mock.calls[0][0].abortSignal!;
        await vi.advanceTimersByTimeAsync(10);
        expect(await failure).toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([100, undefined])('水合不返回时在 %s 预算结束，迟到 ready 不会启动 provider', async explicit => {
        const f = await runtimeFixture();
        const request = explicit === undefined ? {origin: 'Readable English source text.'}
            : f.markTranslationRemainingBudget({origin: 'Readable English source text.', requestTimeoutMs: explicit});
        let error: unknown;
        const result = f.runtime.translateWithCache(request).catch(value => {error = value;});
        await vi.advanceTimersByTimeAsync(explicit ?? 45_000);
        try {
            expect(error).toMatchObject({name: 'TranslationProviderDeadlineError'});
            expect(f.provider).not.toHaveBeenCalled();
        } finally {
            f.provider.mockResolvedValue('有效中文译文');
            f.hydrate(); await flush();
            await result;
        }
        expect(f.provider).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('实际 Vite 翻译组合根的统计可达性', () => {
    it.each([
        ['compact', '0', 'userscript', false, false],
        ['standalone', '1', 'userscript', true, false],
        ['extension', '0', 'chrome', true, true],
    ] as const)('%s 仅打包实际消费的统计仓库', async (_mode, standalone, browser, hasUsage, hasStats) => {
        vi.useRealTimers();
        vi.stubEnv('FLUENTREAD_USERSCRIPT_STANDALONE', standalone);
        vi.stubEnv('FLUENTREAD_USERSCRIPT_GREASYFORK_SOURCE', '0');
        const {mkdtempSync, realpathSync, writeFileSync, rmSync} = await import('node:fs');
        const {tmpdir} = await import('node:os');
        const {resolve, isAbsolute} = await import('node:path');
        const {build} = await import('vite');
        const {default: configuration} = await import('@/userscript/vite.config');
        const config = configuration as import('vite').UserConfig;
        const root = process.cwd();
        const fixture = realpathSync(mkdtempSync(resolve(tmpdir(), 'fluentread-stats-build-')));
        const runtime = resolve(root, 'src/app/translation/runtime.ts');
        const platformFull = resolve(root, 'userscript/platformFull.ts');
        const usage = resolve(root, 'src/platform/storage/modelUsageRepository.ts');
        const stats = resolve(root, 'src/platform/storage/translationStatsRepository.ts');
        const usageAggregation = resolve(root, 'src/services/model-usage/aggregation.ts');
        const statsAggregation = resolve(root, 'src/services/translation-stats/aggregation.ts');
        // 数据库、聚合、handler 和组合根使用真实源码；网络/配置等无关端口外置，避免此构建测试启动页面。
        const owned = new Set([runtime, platformFull, usage, stats, usageAggregation, statsAggregation,
            resolve(root, 'src/services/model-usage/types.ts'), resolve(root, 'src/services/translation-stats/types.ts'),
            resolve(root, 'src/app/background/handlers/modelUsage.ts')]);
        const similar = resolve(fixture, 'modelUsageRepository.ts');
        const rawUsage = usage + '?raw';
        const entry = resolve(fixture, 'entry.ts');
        writeFileSync(similar, 'export const marker = "similarly-named-owner";');
        writeFileSync(entry, `import {translateWithCache} from ${JSON.stringify(runtime)};
            import {marker} from ${JSON.stringify(similar)};
            import source from ${JSON.stringify(rawUsage)};
            ${standalone === '1' ? `import {createPlatformMessageHandler} from ${JSON.stringify(platformFull)};` : ''}
            globalThis.statsBuildFixture = {translateWithCache, marker, source${standalone === '1' ? ', createPlatformMessageHandler' : ''}};`);
        try {
            const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent',
                resolve: config.resolve, define: {...config.define, 'import.meta.env.BROWSER': JSON.stringify(browser)},
                build: {write: false, minify: false, lib: {entry, formats: ['es']},
                    rollupOptions: {external(source, importer) {
                        if (!importer) return false;
                        if (source === entry || source === similar || source === rawUsage) return false;
                        const normalized = source.startsWith('@/') ? resolve(root, source.slice(2)) : source;
                        if (isAbsolute(normalized) && (owned.has(normalized) || owned.has(normalized + '.ts'))) return false;
                        return true;
                    }}}});
            const outputs = Array.isArray(result) ? result : [result];
            if (outputs.length !== 1 || !('output' in outputs[0])) throw new Error('Expected one actual Vite output');
            const chunks = outputs[0].output.filter(item => item.type === 'chunk');
            const moduleIds = chunks.flatMap(chunk => chunk.moduleIds);
            expect(moduleIds).toContain(runtime);
            expect(moduleIds.includes(usage)).toBe(hasUsage);
            expect(moduleIds.includes(usageAggregation)).toBe(hasUsage);
            expect(moduleIds.includes(stats)).toBe(hasStats);
            expect(moduleIds.includes(statsAggregation)).toBe(hasStats);
            expect(moduleIds.includes(platformFull)).toBe(standalone === '1');
            if (standalone === '1') expect(moduleIds).toContain(resolve(root, 'src/app/background/handlers/modelUsage.ts'));
            expect(moduleIds).toContain(similar); expect(moduleIds).toContain(rawUsage);
            expect(chunks.map(chunk => chunk.code).join('\n')).toContain('similarly-named-owner');
        } finally { rmSync(fixture, {recursive: true, force: true}); }
    }, 30_000);
});
