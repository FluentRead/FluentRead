import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    createTranslationRequestScheduler,
    TranslationRequestSchedulerDeadlineError,
    type TranslationRequestSchedulerConfig,
} from '@/src/services/translation/requestScheduler';

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function limits(maxConcurrentTranslations: number) {
    return {maxConcurrentTranslations, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
}

describe('PR906 scheduler independent audit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each<{status: number; headers: Record<string, string>; delay: number}>([
        {status: 429, headers: {}, delay: 2_000},
        {status: 503, headers: {}, delay: 0},
        {status: 429, headers: {'retry-after': '1e3'}, delay: 2_000},
        {status: 429, headers: {'retry-after': 'garbage'}, delay: 2_000},
        {status: 503, headers: {'retry-after': '-2'}, delay: 0},
        {status: 503, headers: {'retry-after': '0'}, delay: 0},
        {status: 429, headers: {'retry-after': new Date(5_000).toUTCString()}, delay: 5_000},
        {status: 503, headers: {'retry-after': new Date(-5_000).toUTCString()}, delay: 0},
        {status: 429, headers: {'retry-after-ms': 'invalid', 'retry-after': '0.25'}, delay: 250},
        {status: 503, headers: {'retry-after-ms': '0', 'retry-after': '2'}, delay: 0},
        {status: 503, headers: {'retry-after-ms': '999999999'}, delay: 7 * 86_400_000},
        {status: 503, headers: {'retry-after': '999999999'}, delay: 7 * 86_400_000},
    ])('honors bounded Retry-After policy for $status with $headers', async ({status, headers, delay}) => {
        const scheduler = createTranslationRequestScheduler(() => limits(1));
        const identity = {service: 'svc', model: 'm', quotaScope: 'header-policy'};
        scheduler.observeResponse(identity, {status, headers: new Headers(headers)});
        const task = vi.fn(async () => 'finished');
        const request = scheduler.scheduleAttempt(task, {identity, countConcurrency: true});
        if (delay > 0) {
            expect(task).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(task).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
        }
        await expect(request).resolves.toBe('finished');
        expect(task).toHaveBeenCalledTimes(1);
    });

    it('ignores responses without a trusted quota and successful responses', async () => {
        const scheduler = createTranslationRequestScheduler(() => limits(1));
        const headers = new Headers({'retry-after': '2'});
        scheduler.observeResponse(undefined, {status: 429, headers});
        scheduler.observeResponse({quotaScope: 'healthy'}, {status: 200, headers});
        const task = vi.fn(async () => 'finished');
        await expect(scheduler.scheduleAttempt(task, {identity: {quotaScope: 'healthy'}, countConcurrency: true}))
            .resolves.toBe('finished');
        expect(task).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the longest observed cooldown and clears it when the clock moves backwards', async () => {
        const scheduler = createTranslationRequestScheduler(() => limits(1));
        const identity = {quotaScope: 'clock-adjustment'};
        scheduler.observeResponse(identity, {status: 429, headers: new Headers({'retry-after': '3'})});
        await vi.advanceTimersByTimeAsync(1_000);
        scheduler.observeResponse(identity, {status: 429, headers: new Headers({'retry-after': '0.25'})});
        const task = vi.fn(async () => 'finished');
        const request = scheduler.scheduleAttempt(task, {identity, countConcurrency: true});
        await vi.advanceTimersByTimeAsync(250);
        expect(task).not.toHaveBeenCalled();
        vi.setSystemTime(0);
        await scheduler.schedule(async () => undefined, {countConcurrency: false, countRate: false});
        await expect(request).resolves.toBe('finished');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets one transport probe after cooldown, backs off again on 429, and only then reopens the scope', async () => {
        const scheduler = createTranslationRequestScheduler(() => limits(5), {random: () => 0.5});
        const identity = {quotaScope: 'recovering'};
        const quotaFailure = {status: 429, headers: new Headers()};
        const retryGate = deferred<void>();
        const successGate = deferred<void>();
        scheduler.observeResponse(identity, quotaFailure);
        const attempt = vi.fn(async lease => {
            await retryGate.promise;
            scheduler.observeResponse(identity, quotaFailure, lease);
        });
        const recovery = vi.fn(async () => {
            await successGate.promise;
        });
        const following = vi.fn(async () => 'translated');
        const initial = scheduler.scheduleAttempt(attempt, {identity, countConcurrency: true});
        const second = scheduler.scheduleAttempt(recovery, {identity, countConcurrency: true});
        const third = scheduler.scheduleAttempt(following, {identity, countConcurrency: true});
        await vi.advanceTimersByTimeAsync(2_000);
        expect(attempt).toHaveBeenCalledOnce();
        expect(recovery).not.toHaveBeenCalled();
        expect(following).not.toHaveBeenCalled();
        await expect(scheduler.scheduleAttempt(async () => 'healthy',
            {identity: {quotaScope: 'other'}, countConcurrency: true})).resolves.toBe('healthy');
        retryGate.resolve();
        await initial;
        await vi.advanceTimersByTimeAsync(4_499);
        expect(recovery).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(recovery).toHaveBeenCalledOnce();
        expect(following).not.toHaveBeenCalled();
        successGate.resolve();
        await second;
        await expect(third).resolves.toBe('translated');
    });

    it('returns a typed cooldown when the next possible attempt is outside the request deadline', async () => {
        const scheduler = createTranslationRequestScheduler(() => limits(1));
        const identity = {quotaScope: 'limited'};
        const headers = new Headers({'retry-after-ms': '7500'});
        scheduler.observeResponse(identity, {status: 429, headers});
        await vi.advanceTimersByTimeAsync(1_000);
        const task = vi.fn(async () => undefined);
        await expect(scheduler.scheduleAttempt(task, {identity, deadlineAt: 5_000}))
            .rejects.toMatchObject({kind: 'rate-limit', statusCode: 429, retryAfterMs: 6_500, retryable: false});
        expect(task).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['global-to-service', 'service-to-model', 'model-to-global'] as const)(
        'reprojects unsettled counted attempts across %s without freeing their slots',
        async (transition) => {
            const config: TranslationRequestSchedulerConfig = {...limits(4)};
            if (transition === 'service-to-model') {
                config.serviceRequestLimits = {svc: {enabled: true, limits: limits(4)}};
            } else if (transition === 'model-to-global') {
                config.maxConcurrentTranslations = 1;
                config.modelRequestLimits = {svc: {m: {enabled: true, limits: limits(4)}}};
            }
            const scheduler = createTranslationRequestScheduler(() => config);
            const identity = {service: 'svc', model: 'm'};
            const gates = [deferred<void>(), deferred<void>()];
            const started: string[] = [];
            const active = gates.map((gate, index) => scheduler.scheduleAttempt(async () => {
                started.push(`active-${index}`);
                await gate.promise;
            }, {identity, countConcurrency: true}));
            if (transition === 'global-to-service') {
                config.serviceRequestLimits = {svc: {enabled: true, limits: limits(1)}};
            } else if (transition === 'service-to-model') {
                config.serviceRequestLimits = {svc: {enabled: false}};
                config.modelRequestLimits = {svc: {m: {enabled: true, limits: limits(1)}}};
            } else {
                config.modelRequestLimits = {};
            }
            const waiting = scheduler.scheduleAttempt(async () => {
                started.push('waiting');
                return 'finished';
            }, {identity, countConcurrency: true});
            try {
                await flushMicrotasks();
                expect(started).toEqual(['active-0', 'active-1']);
                gates[0]!.resolve();
                await active[0];
                await flushMicrotasks();
                expect(started).toEqual(['active-0', 'active-1']);
                gates[1]!.resolve();
                await expect(waiting).resolves.toBe('finished');
                expect(started).toEqual(['active-0', 'active-1', 'waiting']);
            } finally {
                gates.forEach(gate => gate.resolve());
                await Promise.allSettled([...active, waiting]);
            }
        },
    );

    it.each([
        {status: 429, header: 'retry-after', value: '2', delay: 2_000},
        {status: 503, header: 'retry-after-ms', value: '250', delay: 250},
    ])('applies $status Retry-After before transport release and lets a healthy scope pass',
        async ({status, header, value, delay}) => {
            const scheduler = createTranslationRequestScheduler(() => limits(1));
            const identity = {service: 'svc', model: 'm', quotaScope: 'frozen-scope-A'};
            const gate = deferred<void>();
            const started: string[] = [];
            const active = scheduler.scheduleAttempt(async () => {
                started.push('active');
                await gate.promise;
            }, {identity, countConcurrency: true});
            const cooled = scheduler.scheduleAttempt(async () => {
                started.push('cooled');
                return 'cooled-result';
            }, {identity, countConcurrency: true});
            const healthy = scheduler.scheduleAttempt(async () => {
                started.push('healthy');
                return 'healthy-result';
            }, {identity: {...identity, quotaScope: 'frozen-scope-B'}, countConcurrency: true});
            try {
                scheduler.observeResponse(identity, {status, headers: new Headers({[header]: value})});
                expect(started).toEqual(['active']);
                gate.resolve();
                await expect(healthy).resolves.toBe('healthy-result');
                expect(started).toEqual(['active', 'healthy']);
                await vi.advanceTimersByTimeAsync(delay - 1);
                expect(started).toEqual(['active', 'healthy']);
                await vi.advanceTimersByTimeAsync(1);
                await expect(cooled).resolves.toBe('cooled-result');
                expect(started).toEqual(['active', 'healthy', 'cooled']);
            } finally {
                gate.resolve();
                await vi.runOnlyPendingTimersAsync();
                await Promise.allSettled([active, cooled, healthy]);
            }
        },
    );

    it('mixes legacy probes with counted attempts without double-counting concurrency or bypassing rate limits', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            ...limits(1), translationRequestsPerSecond: 1,
        }));
        const identity = {service: 'svc', model: 'm'};
        const outerGate = deferred<void>();
        const order: string[] = [];
        const outer = scheduler.schedule(async () => {
            order.push('outer');
            await outerGate.promise;
        }, {identity, countRate: false});
        const counted = scheduler.scheduleAttempt(async () => {
            order.push('counted');
            return 'counted-result';
        }, {identity, countConcurrency: true});
        const legacyFirst = scheduler.scheduleAttempt(async () => {
            order.push('legacy-first');
            return 'first-result';
        }, {identity});
        const legacySecond = scheduler.scheduleAttempt(async () => {
            order.push('legacy-second');
            return 'second-result';
        }, {identity});
        try {
            await flushMicrotasks();
            expect(order).toEqual(['outer', 'legacy-first']);
            await expect(legacyFirst).resolves.toBe('first-result');
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(legacySecond).resolves.toBe('second-result');
            expect(order).toEqual(['outer', 'legacy-first', 'legacy-second']);
            outerGate.resolve();
            await outer;
            await flushMicrotasks();
            expect(order).toEqual(['outer', 'legacy-first', 'legacy-second']);
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(counted).resolves.toBe('counted-result');
            expect(order).toEqual(['outer', 'legacy-first', 'legacy-second', 'counted']);
        } finally {
            outerGate.resolve();
            await vi.runOnlyPendingTimersAsync();
            await Promise.allSettled([outer, counted, legacyFirst, legacySecond]);
        }
    });

    it.each(['resolve', 'reject'] as const)(
        'does not release an aborted counted attempt until its actual task %s settles',
        async (settlement) => {
            const scheduler = createTranslationRequestScheduler(() => limits(1));
            const controller = new AbortController();
            const transport = deferred<void>();
            const started: string[] = [];
            const active = scheduler.scheduleAttempt(async () => {
                started.push('active');
                await transport.promise;
            }, {signal: controller.signal, countConcurrency: true});
            const outcome = active.catch(error => error);
            const waiting = scheduler.scheduleAttempt(async () => {
                started.push('waiting');
                return 'finished';
            }, {countConcurrency: true});
            try {
                controller.abort();
                await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
                await flushMicrotasks();
                expect(started).toEqual(['active']);
                if (settlement === 'resolve') transport.resolve();
                else transport.reject(new Error('synthetic transport rejection'));
                await expect(waiting).resolves.toBe('finished');
                expect(started).toEqual(['active', 'waiting']);
            } finally {
                transport.resolve();
                await Promise.allSettled([active, waiting]);
            }
        },
    );

    it('expires a queued counted attempt without borrowing the still-running transport slot', async () => {
        const scheduler = createTranslationRequestScheduler(() => limits(1));
        const transport = deferred<void>();
        const started: string[] = [];
        const active = scheduler.scheduleAttempt(async () => {
            started.push('active');
            await transport.promise;
        }, {countConcurrency: true});
        const expired = scheduler.scheduleAttempt(async () => {
            started.push('expired');
        }, {countConcurrency: true, deadlineAt: 100});
        const outcome = expired.catch(error => error);
        const waiting = scheduler.scheduleAttempt(async () => {
            started.push('waiting');
        }, {countConcurrency: true});
        try {
            await vi.advanceTimersByTimeAsync(100);
            await expect(outcome).resolves.toBeInstanceOf(TranslationRequestSchedulerDeadlineError);
            expect(started).toEqual(['active']);
            transport.resolve();
            await waiting;
            expect(started).toEqual(['active', 'waiting']);
        } finally {
            transport.resolve();
            await Promise.allSettled([active, expired, waiting]);
        }
    });
});
