import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    FluentReadTranslationStatsDatabase,
    TranslationStatsRepository,
    normalizeTranslationRequestEvent,
    translationStatsRepository,
    type TranslationStatsRepositoryOptions,
} from '@/src/platform/storage/translationStatsRepository';
import {localHourBucketStart} from '@/src/services/translation-stats/aggregation';
import type {TranslationRequestStatsEvent} from '@/src/services/translation-stats/types';

const NOW = new Date(2026, 8, 16, 15, 20).getTime();
const DAY = 24 * 60 * 60 * 1000;
let databaseSequence = 0;
const databases: FluentReadTranslationStatsDatabase[] = [];

function createRepository(options: TranslationStatsRepositoryOptions = {}) {
    databaseSequence += 1;
    const database = new FluentReadTranslationStatsDatabase(`FluentReadTranslationStats-test-${databaseSequence}`);
    databases.push(database);
    const timers: Array<() => void> = [];
    const warn = vi.fn();
    const repository = new TranslationStatsRepository(database, {
        now: () => NOW,
        setTimer: (callback) => {
            timers.push(callback);
            return timers.length;
        },
        clearTimer: vi.fn(),
        warn,
        ...options,
    });
    return {repository, database, timers, warn};
}

function requestEvent(overrides: Partial<TranslationRequestStatsEvent> = {}): TranslationRequestStatsEvent {
    return {
        startedAt: new Date(2026, 8, 16, 10, 15).getTime(),
        durationMs: 800,
        serviceId: 'microsoft',
        mode: 'single',
        segmentCount: 1,
        sourceChars: 120,
        sourceBytes: 180,
        resultChars: 100,
        source: 'network',
        cachedSegments: 0,
        upstreamCalls: 1,
        upstreamMs: 700,
        outcome: 'success',
        ...overrides,
    };
}

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(databases.splice(0).map(async (database) => {
        database.close();
        await database.delete();
    }));
});

describe('翻译统计事件白名单', () => {
    it('只保留数值与标识字段，并清理标识中的控制字符', () => {
        const stored = normalizeTranslationRequestEvent({
            ...requestEvent({id: ' request-1 ', serviceId: ' open\u0007ai ', model: ' gpt  5 '}),
            origin: '不得保存的原文',
            result: '不得保存的译文',
            url: 'https://private.example/path',
        } as TranslationRequestStatsEvent);

        expect(stored).toEqual({
            id: 'request-1',
            schemaVersion: 1,
            startedAt: new Date(2026, 8, 16, 10, 15).getTime(),
            durationMs: 800,
            serviceId: 'openai',
            model: 'gpt 5',
            mode: 'single',
            segmentCount: 1,
            sourceChars: 120,
            sourceBytes: 180,
            resultChars: 100,
            source: 'network',
            cachedSegments: 0,
            upstreamCalls: 1,
            upstreamMs: 700,
            outcome: 'success',
            routes: [],
        });
    });

    it('失败原因与状态码只随失败保留，未知分类归入 unknown，无效状态码省略', () => {
        expect(normalizeTranslationRequestEvent(requestEvent({outcome: 'error', errorKind: 'rate-limit', statusCode: 429, resultChars: 5})))
            .toMatchObject({outcome: 'error', errorKind: 'rate-limit', statusCode: 429});
        expect(normalizeTranslationRequestEvent(requestEvent({outcome: 'error', resultChars: 5})).resultChars).toBeUndefined();
        expect(normalizeTranslationRequestEvent(requestEvent({outcome: 'timeout', errorKind: 'weird' as never, statusCode: 99})))
            .toMatchObject({errorKind: 'unknown'});
        expect(normalizeTranslationRequestEvent(requestEvent({outcome: 'timeout', statusCode: 99})).statusCode).toBeUndefined();
        expect(normalizeTranslationRequestEvent(requestEvent({outcome: 'error', statusCode: 600})).statusCode).toBeUndefined();
        const cancelled = normalizeTranslationRequestEvent(requestEvent({outcome: 'cancelled', errorKind: 'network', statusCode: 500}));
        expect(cancelled.errorKind).toBeUndefined();
        expect(cancelled.statusCode).toBeUndefined();
        const success = normalizeTranslationRequestEvent(requestEvent({errorKind: 'network', statusCode: 500, resultChars: undefined, model: undefined}));
        expect(success).not.toHaveProperty('errorKind');
        expect(success).not.toHaveProperty('resultChars');
        expect(success.model).toBe('');
        expect(normalizeTranslationRequestEvent(requestEvent({model: '\u0000'})).model).toBe('');
    });

    it('拒绝非法结构、版本、枚举、数值和空服务标识', () => {
        const invalid: unknown[] = [
            null,
            [],
            {...requestEvent(), schemaVersion: 2},
            requestEvent({outcome: 'done' as never}),
            requestEvent({source: 1 as never}),
            requestEvent({mode: 'stream' as never}),
            requestEvent({segmentCount: 1.5}),
            requestEvent({cachedSegments: 2, segmentCount: 1}),
            requestEvent({sourceChars: -1}),
            requestEvent({durationMs: Number.NaN}),
            requestEvent({upstreamMs: '1' as never}),
            requestEvent({startedAt: 8_640_000_000_000_001}),
            requestEvent({serviceId: '   '}),
            requestEvent({serviceId: 7 as never}),
            requestEvent({id: ''}),
            requestEvent({resultChars: -3}),
        ];
        for (const value of invalid) expect(() => normalizeTranslationRequestEvent(value as TranslationRequestStatsEvent)).toThrow(TypeError);
        expect(normalizeTranslationRequestEvent({...requestEvent(), schemaVersion: 1}).schemaVersion).toBe(1);
    });

    it('缺少 id 时优先使用 randomUUID，不可用时生成带序号的回退标识', () => {
        expect(normalizeTranslationRequestEvent(requestEvent()).id).toMatch(/^[0-9a-f-]{36}$/u);
        vi.stubGlobal('crypto', undefined);
        const first = normalizeTranslationRequestEvent(requestEvent()).id;
        const second = normalizeTranslationRequestEvent(requestEvent()).id;
        expect(first).toMatch(/^request-/u);
        expect(second).not.toBe(first);
    });
});

describe('翻译统计 IndexedDB 仓库', () => {
    it('缓冲写入只安排一次定时刷新，并按小时、服务和模型折叠汇总', async () => {
        const {repository, database, timers} = createRepository();
        repository.record(requestEvent({id: 'a'}));
        repository.record(requestEvent({id: 'b', durationMs: 1_600, startedAt: new Date(2026, 8, 16, 10, 50).getTime()}));
        repository.record(requestEvent({id: 'c', serviceId: 'openai', model: 'gpt', source: 'cache', cachedSegments: 1}));
        expect(timers).toHaveLength(1);
        expect(await database.requests.count()).toBe(0);

        timers[0]();
        await repository.flush();

        expect(await database.requests.count()).toBe(3);
        const rollups = await database.rollups.toArray();
        expect(rollups).toHaveLength(2);
        const microsoft = rollups.find((rollup) => rollup.serviceId === 'microsoft')!;
        expect(microsoft).toMatchObject({
            bucketStart: localHourBucketStart(new Date(2026, 8, 16, 10).getTime()),
            model: '',
            requestCount: 2,
            latencyCount: 2,
            latencyDurationMs: 2_400,
        });

        repository.record(requestEvent({id: 'd', durationMs: 200}));
        await repository.flush();
        expect((await database.rollups.get([microsoft.bucketStart, 'microsoft', '']))?.requestCount).toBe(3);
        await repository.flush();
        expect(await database.requests.count()).toBe(4);
    });

    it('队列达到上限立即写入，旧代次与非法事件被忽略', async () => {
        const {repository, database, timers, warn} = createRepository({maxBufferedEvents: 2});
        const generation = repository.captureGeneration();
        repository.record(requestEvent({outcome: 'nope' as never}));
        expect(warn).toHaveBeenCalledWith('[FluentRead] translation stats event rejected:', expect.any(TypeError));
        repository.record(requestEvent({id: 'x'}), generation + 1);
        repository.record(requestEvent({id: 'y'}));
        repository.record(requestEvent({id: 'z'}));
        await vi.waitFor(async () => expect(await database.requests.count()).toBe(2));
        expect(timers).toHaveLength(1);
    });

    it('超出保留上限删除最早请求记录，过期小时汇总按保留天数清理', async () => {
        const {repository, database} = createRepository({maxStoredRequests: 2, rollupRetentionDays: 10});
        repository.record(requestEvent({id: 'old', startedAt: NOW - 20 * DAY}));
        repository.record(requestEvent({id: 'mid', startedAt: NOW - 2 * DAY}));
        repository.record(requestEvent({id: 'new', startedAt: NOW - DAY}));
        await repository.flush();

        expect((await database.requests.toArray()).map((event) => event.id).sort()).toEqual(['mid', 'new']);
        expect((await database.rollups.toArray()).map((rollup) => rollup.bucketStart).sort())
            .toEqual([localHourBucketStart(NOW - 2 * DAY), localHourBucketStart(NOW - DAY)].sort());
    });

    it('线路尝试折叠进线路汇总，请求记录只保留去重后的线路标识', async () => {
        const {repository, database} = createRepository();
        repository.record(requestEvent({
            id: 'free-1',
            serviceId: 'freeTranslation',
            routes: ['google', 'microsoft', 'google'],
            routeAttempts: [
                {route: 'microsoft', outcome: 'error', durationMs: 900, chars: 12},
                {route: 'google', outcome: 'success', durationMs: 300, chars: 12},
            ],
        }));
        repository.record(requestEvent({
            id: 'free-2',
            serviceId: 'freeTranslation',
            routes: ['google'],
            routeAttempts: [{route: 'google', outcome: 'success', durationMs: 500, chars: 20}],
        }));
        await repository.flush();

        expect((await database.requests.get('free-1'))?.routes).toEqual(['google', 'microsoft']);
        const rollups = await database.routes.toArray();
        expect(rollups.map((rollup) => [rollup.route, rollup.attemptCount, rollup.latencyCount, rollup.latencyDurationMs]).sort())
            .toEqual([['google', 2, 2, 800], ['microsoft', 1, 0, 0]]);

        const snapshot = await repository.getDashboard({range: 'today'});
        expect(snapshot.routes.map((item) => [item.route, item.totals.attemptCount, item.totals.successRate]))
            .toEqual([['google', 2, 1], ['microsoft', 1, 0]]);
        await repository.clear();
        expect(await database.routes.count()).toBe(0);
    });

    it('线路标识与尝试按白名单过滤，超出上限的尝试被丢弃', async () => {
        const {repository, database} = createRepository();
        repository.record(requestEvent({
            id: 'free-invalid',
            serviceId: 'freeTranslation',
            routes: ['google', '', 7 as never, 'x'.repeat(260), ...Array.from({length: 20}, (_, index) => `route-${index}`)],
            routeAttempts: [
                {route: 'google', outcome: 'success', durationMs: 100, chars: 5},
                {route: '', outcome: 'success', durationMs: 100, chars: 5},
                {route: 42 as never, outcome: 'success', durationMs: 100, chars: 5},
                {route: 'google', outcome: 'unknown' as never, durationMs: 100, chars: 5},
                {route: 'google', outcome: 'success', durationMs: -1, chars: 5},
                {route: 'google', outcome: 'success', durationMs: 100, chars: 1.5},
                'not-an-attempt' as never,
                null as never,
                ...Array.from({length: 300}, () => ({route: 'microsoft', outcome: 'success' as const, durationMs: 10, chars: 1})),
            ],
        }));
        await repository.flush();

        const stored = await database.requests.get('free-invalid');
        expect(stored?.routes).toHaveLength(12);
        expect(stored?.routes).toContain('google');
        const rollups = await database.routes.toArray();
        expect(rollups.find((rollup) => rollup.route === 'google')?.attemptCount).toBe(1);
        // 上限之前的 8 条里只有 1 条合法，其余 192 条 microsoft 尝试来自截断后的队列。
        expect(rollups.find((rollup) => rollup.route === 'microsoft')?.attemptCount).toBe(192);
        expect(await database.requests.count()).toBe(1);
    });

    it('快照先刷新队列，返回全部维度、最早记录与当前范围聚合', async () => {
        const {repository} = createRepository();
        const empty = await repository.getDashboard();
        expect(empty.recordingStartedAt).toBeNull();
        expect(empty.dimensions).toEqual([]);

        repository.record(requestEvent({id: 'week', startedAt: NOW - 3 * DAY, serviceId: 'google'}));
        repository.record(requestEvent({id: 'month', startedAt: NOW - 20 * DAY, serviceId: 'deepL'}));
        repository.record(requestEvent({id: 'gpt-a', serviceId: 'openai', model: 'gpt-a'}));
        repository.record(requestEvent({id: 'gpt-b', serviceId: 'openai', model: 'gpt-b', outcome: 'error', errorKind: 'network'}));

        const week = await repository.getDashboard({range: '7d'});
        expect(week.selected.totals.requestCount).toBe(3);
        expect(week.recordingStartedAt).toBe(localHourBucketStart(NOW - 20 * DAY));
        expect(week.dimensions).toEqual([
            {serviceId: 'deepL', models: ['']},
            {serviceId: 'google', models: ['']},
            {serviceId: 'openai', models: ['gpt-a', 'gpt-b']},
        ]);
        const filtered = await repository.getDashboard({range: 'today', serviceId: 'openai', model: 'gpt-b'}, NOW);
        expect(filtered.selected.totals).toMatchObject({requestCount: 1, errorKinds: {network: 1}});
    });

    it('请求记录按范围与来源、结果、服务、模型筛选，支持最新与最慢排序分页', async () => {
        const {repository} = createRepository();
        const at = (hour: number, minute = 0) => new Date(2026, 8, 16, hour, minute).getTime();
        repository.record(requestEvent({id: 'r1', startedAt: at(9), durationMs: 300}));
        repository.record(requestEvent({id: 'r2', startedAt: at(10), durationMs: 3_000, serviceId: 'openai', model: 'gpt'}));
        repository.record(requestEvent({id: 'r3', startedAt: at(11), durationMs: 3_000, source: 'cache', cachedSegments: 1}));
        repository.record(requestEvent({id: 'r4', startedAt: at(11), durationMs: 50, outcome: 'timeout', errorKind: 'timeout'}));
        repository.record(requestEvent({id: 'r5', startedAt: NOW - 10 * DAY, durationMs: 9_000}));

        const recent = await repository.getRequestLog({filter: {range: '7d'}});
        expect(recent).toMatchObject({sort: 'recent', offset: 0, limit: 20, totalCount: 4, generatedAt: NOW});
        expect(recent.items.map((item) => item.id)).toEqual(['r4', 'r3', 'r2', 'r1']);

        const slowest = await repository.getRequestLog({filter: {range: 'today'}, sort: 'slowest', offset: 1, limit: 2}, NOW);
        expect(slowest.items.map((item) => item.id)).toEqual(['r2', 'r1']);
        expect((await repository.getRequestLog({filter: {range: '30d'}, sort: 'slowest', limit: 1})).items[0].id).toBe('r5');

        const byFilters = await Promise.all([
            repository.getRequestLog({filter: {range: 'today', source: 'cache'}}),
            repository.getRequestLog({filter: {range: 'today', outcome: 'timeout'}}),
            repository.getRequestLog({filter: {range: 'today', serviceId: 'openai', model: 'gpt'}}),
            repository.getRequestLog({filter: {range: 'today', serviceId: 'microsoft', model: ''}}),
        ]);
        expect(byFilters.map((page) => page.items.map((item) => item.id))).toEqual([['r3'], ['r4'], ['r2'], ['r4', 'r3', 'r1']]);
        expect(byFilters[0].filter).toEqual({range: 'today', source: 'cache'});

        await expect(repository.getRequestLog({filter: {range: 'today'}, limit: 0})).rejects.toThrow('limit');
        await expect(repository.getRequestLog({filter: {range: 'today'}, offset: -1})).rejects.toThrow('offset');
        await expect(repository.getRequestLog({filter: {range: 'today', source: 'disk' as never}})).rejects.toThrow('source');
        await expect(repository.getRequestLog({filter: {range: 'today', outcome: 'ok' as never}})).rejects.toThrow('outcome');
    });

    it('清除统计推进代次、丢弃队列并等待进行中的写入后清空两张表', async () => {
        const {repository, database, timers} = createRepository();
        repository.record(requestEvent({id: 'persisted'}));
        await repository.flush();
        const staleGeneration = repository.captureGeneration();
        repository.record(requestEvent({id: 'queued'}));
        const flushing = repository.flush();
        repository.record(requestEvent({id: 'pending-timer'}));

        await repository.clear();
        await flushing;
        repository.record(requestEvent({id: 'stale'}), staleGeneration);
        timers.at(-1)?.();
        await repository.flush();

        expect(await database.requests.count()).toBe(0);
        expect(await database.rollups.count()).toBe(0);
        expect(repository.captureGeneration()).toBe(staleGeneration + 1);

        repository.record(requestEvent({id: 'after-clear'}));
        await repository.clear();
        repository.record(requestEvent({id: 'fresh'}));
        await repository.flush();
        expect((await database.requests.toArray()).map((event) => event.id)).toEqual(['fresh']);
    });

    it('存储失败只告警并继续执行后续操作', async () => {
        const {repository, database, warn} = createRepository();
        const failure = new Error('IndexedDB unavailable');
        vi.spyOn(database.requests, 'bulkPut').mockRejectedValueOnce(failure);
        repository.record(requestEvent({id: 'lost'}));
        await expect(repository.flush()).rejects.toThrow('IndexedDB unavailable');
        expect(warn).toHaveBeenCalledWith('[FluentRead] translation stats storage failed:', failure);

        repository.record(requestEvent({id: 'kept'}));
        await repository.flush();
        expect((await database.requests.toArray()).map((event) => event.id)).toEqual(['kept']);
    });

    it('默认选项使用真实定时器、系统时间与控制台告警', async () => {
        databaseSequence += 1;
        const database = new FluentReadTranslationStatsDatabase(`FluentReadTranslationStats-default-${databaseSequence}`);
        databases.push(database);
        const repository = new TranslationStatsRepository(database, {flushDelayMs: 5});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        repository.record(requestEvent({id: 'timer', startedAt: Date.now()}));
        await vi.waitFor(async () => expect(await database.requests.count()).toBe(1));
        repository.record(requestEvent({id: 'manual', startedAt: Date.now()}));
        await repository.flush();
        expect(await database.requests.count()).toBe(2);
        expect((await repository.getDashboard({range: 'today'})).selected.totals.requestCount).toBe(2);
        expect((await repository.getRequestLog({filter: {range: 'today'}})).totalCount).toBe(2);

        repository.record(requestEvent({mode: 'bad' as never}));
        expect(consoleWarn).toHaveBeenCalledWith('[FluentRead] translation stats event rejected:', expect.any(TypeError));
        expect(translationStatsRepository).toBeInstanceOf(TranslationStatsRepository);
        expect(translationStatsRepository.database.name).toBe('FluentReadTranslationStats');
    });
});
