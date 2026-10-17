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

async function flushMicrotasks(times = 8): Promise<void> {
    for (let index = 0; index < times; index += 1) await Promise.resolve();
}

describe('translation request scheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('按配置限制并发请求并保持 FIFO', async () => {
        const config = {
            maxConcurrentTranslations: 2,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const controls = Array.from({length: 3}, () => deferred<number>());
        const started: number[] = [];
        const jobs = controls.map((control, index) => scheduler.schedule(async () => {
            started.push(index);
            return control.promise;
        }));

        expect(started).toEqual([0, 1]);
        controls[0]!.resolve(0);
        await expect(jobs[0]).resolves.toBe(0);
        await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));

        controls[1]!.resolve(1);
        controls[2]!.resolve(2);
        await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2]);
    });

    it('同时执行每秒和每分钟滑动窗口限制', async () => {
        const config = {
            maxConcurrentTranslations: 10,
            translationRequestsPerSecond: 2,
            translationRequestsPerMinute: 3,
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const started: number[] = [];
        const jobs = Array.from({length: 4}, (_, index) => scheduler.schedule(async () => {
            started.push(Date.now());
            return index;
        }));

        await flushMicrotasks();
        expect(started).toHaveLength(2);
        expect(started).toEqual([0, 0]);

        await vi.advanceTimersByTimeAsync(999);
        expect(started).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(started).toHaveLength(3);
        expect(started[2]).toBe(1000);

        await vi.advanceTimersByTimeAsync(58_999);
        expect(started).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
        expect(started).toHaveLength(4);
        expect(started[3]).toBe(60_000);
        await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3]);
    });

    it.each([
        ['global', 'service'], ['service', 'global'],
        ['global', 'model'], ['model', 'global'],
        ['service', 'model'], ['model', 'service'],
    ])('在途请求从 %s 切换到 %s 限制后仍计入并发上限', async (before, after) => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config: TranslationRequestSchedulerConfig = {...limits};
        const selectScope = (scope: string) => {
            config.serviceRequestLimits = {ollama: {enabled: scope === 'service', limits}};
            config.modelRequestLimits = {ollama: {'qwen3:8b': {enabled: scope === 'model', limits}}};
        };
        selectScope(before);
        const scheduler = createTranslationRequestScheduler(() => config);
        const identity = {service: 'ollama', model: 'qwen3:8b'};
        const blocker = deferred<void>();
        const started: string[] = [];
        const first = scheduler.schedule(async () => {started.push('first'); await blocker.promise;}, {identity});
        selectScope(after);
        const second = scheduler.schedule(async () => {started.push('second');}, {identity});
        try {
            await flushMicrotasks();
            expect(started).toEqual(['first']);
        } finally {
            blocker.resolve();
            await Promise.all([first, second]);
        }
        expect(started).toEqual(['first', 'second']);
    });

    it('降低并发上限后等待已有请求结束到上限以下，保留所有在途任务', async () => {
        const config = {maxConcurrentTranslations: 3, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const scheduler = createTranslationRequestScheduler(() => config);
        const gates = Array.from({length: 3}, () => deferred<void>());
        const started: number[] = [];
        const jobs = gates.map((gate, index) => scheduler.schedule(async () => {started.push(index); await gate.promise;}));
        config.maxConcurrentTranslations = 1;
        jobs.push(scheduler.schedule(async () => {started.push(3);}));
        try {
            gates[0]!.resolve(); gates[1]!.resolve();
            await flushMicrotasks();
            expect(started).toEqual([0, 1, 2]);
        } finally {
            gates.forEach(gate => gate.resolve());
            await Promise.all(jobs);
        }
        expect(started).toEqual([0, 1, 2, 3]);
    });

    it('新启用服务总限制时合计不同模型的在途请求，并允许其他服务独立启动', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config: TranslationRequestSchedulerConfig = {
            ...limits,
            modelRequestLimits: {ollama: {a: {enabled: true, limits}, b: {enabled: true, limits}}},
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const gates = [deferred<void>(), deferred<void>()];
        const started: string[] = [];
        const jobs = ['a', 'b'].map((model, index) => scheduler.schedule(async () => {
            started.push(model); await gates[index]!.promise;
        }, {identity: {service: 'ollama', model}}));
        config.serviceRequestLimits = {ollama: {enabled: true, limits}};
        jobs.push(scheduler.schedule(async () => {started.push('c');}, {identity: {service: 'ollama', model: 'c'}}));
        jobs.push(scheduler.schedule(async () => {started.push('other');}, {identity: {service: 'other'}}));
        try {
            await flushMicrotasks();
            expect(started).toEqual(['a', 'b', 'other']);
            gates[0]!.resolve();
            await flushMicrotasks();
            expect(started).toEqual(['a', 'b', 'other']);
        } finally {
            gates.forEach(gate => gate.resolve());
            await Promise.all(jobs);
        }
        expect(started).toEqual(['a', 'b', 'other', 'c']);
    });

    it('切换限制后已返回结果的 transport lease 仍占并发槽，attempt 不额外占槽', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config: TranslationRequestSchedulerConfig = {...limits};
        const scheduler = createTranslationRequestScheduler(() => config);
        const identity = {service: 'ollama', model: 'qwen3:8b'};
        const transport = deferred<void>();
        const started: string[] = [];
        const first = scheduler.schedule(async (lease) => {
            lease.holdUntil(transport.promise);
            started.push('first');
            return 'caller-result';
        }, {identity, countRate: false});
        await expect(first).resolves.toBe('caller-result');
        config.modelRequestLimits = {ollama: {'qwen3:8b': {enabled: true, limits}}};
        const second = scheduler.schedule(async () => {started.push('second');}, {identity});
        try {
            await expect(scheduler.scheduleAttempt(async () => {started.push('attempt'); return 'attempt-result';}, {identity}))
                .resolves.toBe('attempt-result');
            expect(started).toEqual(['first', 'attempt']);
        } finally {
            transport.resolve();
            await second;
        }
        expect(started).toEqual(['first', 'attempt', 'second']);
    });

    it('取消调用方后切换限制仍等待旧传输结束才启动下一请求', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config: TranslationRequestSchedulerConfig = {...limits};
        const scheduler = createTranslationRequestScheduler(() => config);
        const identity = {service: 'ollama', model: 'qwen3:8b'};
        const controller = new AbortController();
        const transport = deferred<void>();
        const started: string[] = [];
        const first = scheduler.schedule(async () => {started.push('first'); await transport.promise;}, {
            identity, signal: controller.signal,
        });
        const outcome = first.catch(error => error);
        controller.abort();
        await expect(outcome).resolves.toMatchObject({name: 'AbortError'});
        config.serviceRequestLimits = {ollama: {enabled: true, limits}};
        const second = scheduler.schedule(async () => {started.push('second');}, {identity});
        try {
            await flushMicrotasks();
            expect(started).toEqual(['first']);
        } finally {
            transport.resolve();
            await second;
        }
        expect(started).toEqual(['first', 'second']);
    });

    it('排队中的请求可取消，并在达到 provider 预算前拒绝过期任务', async () => {
        const config = {
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const blocker = deferred<string>();
        const first = scheduler.schedule(async () => blocker.promise);
        const controller = new AbortController();
        const cancelled = scheduler.schedule(async () => 'never', {signal: controller.signal});
        const expired = scheduler.schedule(async () => 'never', {deadlineAt: 100});
        const later = scheduler.schedule(async () => 'never', {deadlineAt: 200});
        const expiredOutcome = expired.catch((error) => error);
        const laterOutcome = later.catch((error) => error);

        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(100);
        await expect(expiredOutcome).resolves.toBeInstanceOf(TranslationRequestSchedulerDeadlineError);
        await vi.advanceTimersByTimeAsync(100);
        await expect(laterOutcome).resolves.toBeInstanceOf(TranslationRequestSchedulerDeadlineError);

        blocker.resolve('done');
        await expect(first).resolves.toBe('done');
    });

    it('调用方先收到结果时仍保留真实 transport 的调度槽', async () => {
        const config = {
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const transport = deferred<void>();
        const started: string[] = [];
        const first = scheduler.schedule(async (lease) => {
            started.push('first');
            lease.holdUntil(transport.promise);
            return 'caller-result';
        });
        const second = scheduler.schedule(async () => {
            started.push('second');
            return 'second-result';
        });

        await expect(first).resolves.toBe('caller-result');
        expect(started).toEqual(['first']);
        transport.resolve();
        await expect(second).resolves.toBe('second-result');
        expect(started).toEqual(['first', 'second']);
    });

    it('请求任务结束后不允许继续追加 transport lease', async () => {
        let capturedLease: {holdUntil: (settlement: PromiseLike<unknown>) => void} | undefined;
        await expect(schedulerForLeaseTest((lease) => {
            capturedLease = lease;
            return Promise.resolve('done');
        })).resolves.toBe('done');
        expect(() => capturedLease?.holdUntil(Promise.resolve())).toThrow(
            '翻译请求已结束，无法继续占用调度槽',
        );
    });

    it('配置读取失败时回退到安全默认调度', async () => {
        const scheduler = createTranslationRequestScheduler(() => {
            throw new Error('config unavailable');
        });

        await expect(scheduler.schedule(async () => 'safe-default')).resolves.toBe('safe-default');
    });

    it('入队前已取消的请求立即拒绝且不启动任务', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const controller = new AbortController();
        controller.abort();
        const task = vi.fn(async () => 'never');

        await expect(scheduler.schedule(task, {signal: controller.signal}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(task).not.toHaveBeenCalled();

        const completedController = new AbortController();
        await expect(scheduler.schedule(async () => 'completed', {
            signal: completedController.signal,
        })).resolves.toBe('completed');
    });

    it('任务内部再次入队时保持防重入并继续调度', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        let nested!: Promise<string>;
        const first = scheduler.schedule(async () => {
            nested = scheduler.schedule(async () => 'nested');
            return 'first';
        });

        await expect(first).resolves.toBe('first');
        await expect(nested).resolves.toBe('nested');
    });

    it('非有限时钟回退到系统时间，并在时钟回拨后清理旧窗口', async () => {
        const nonFiniteScheduler = createTranslationRequestScheduler(
            () => ({maxConcurrentTranslations: 1}),
            {now: () => Number.NaN},
        );
        await expect(nonFiniteScheduler.schedule(async () => 'system-time')).resolves.toBe('system-time');

        const clockValues = [100, 50, 50];
        const backwardsScheduler = createTranslationRequestScheduler(
            () => ({
                maxConcurrentTranslations: 1,
                translationRequestsPerSecond: 1,
                translationRequestsPerMinute: 0,
            }),
            {now: () => clockValues.shift() ?? 50},
        );
        await expect(backwardsScheduler.schedule(async () => 'first')).resolves.toBe('first');
        await flushMicrotasks();
        await expect(backwardsScheduler.schedule(async () => 'second')).resolves.toBe('second');
    });

    it('配置返回 null 时仍使用安全默认调度', async () => {
        const scheduler = createTranslationRequestScheduler(() => null as never);
        await expect(scheduler.schedule(async () => 'null-config')).resolves.toBe('null-config');
    });

    it('独立服务 bucket 互不占用全局并发，并跳过被阻塞的服务队首', async () => {
        const config = {
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
            serviceRequestLimits: {
                alpha: {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}},
                beta: {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}},
            },
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const alphaBlocker = deferred<void>(); const started: string[] = [];
        const first = scheduler.schedule(async () => { started.push('alpha-1'); await alphaBlocker.promise; }, {identity: {service: 'alpha', model: 'a'}});
        const second = scheduler.schedule(async () => { started.push('alpha-2'); }, {identity: {service: 'alpha', model: 'a'}});
        const beta = scheduler.schedule(async () => { started.push('beta'); }, {identity: {service: 'beta', model: 'b'}});
        await flushMicrotasks();
        expect(started).toEqual(['alpha-1', 'beta']);
        alphaBlocker.resolve();
        await expect(Promise.all([first, second, beta])).resolves.toEqual([undefined, undefined, undefined]);
        expect(started).toEqual(['alpha-1', 'beta', 'alpha-2']);
    });

    it('模型 bucket 与服务 aggregate 同时生效，模型任务不绕过服务 cap', async () => {
        const config = {
            maxConcurrentTranslations: 6, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0,
            serviceRequestLimits: {svc: {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}}},
            modelRequestLimits: {svc: {
                a: {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}},
                b: {enabled: true, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}},
            }},
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const blocker = deferred<void>(); const started: string[] = [];
        const first = scheduler.schedule(async () => { started.push('a'); await blocker.promise; }, {identity: {service: 'svc', model: 'a'}});
        const second = scheduler.schedule(async () => { started.push('b'); }, {identity: {service: 'svc', model: 'b'}});
        await flushMicrotasks(); expect(started).toEqual(['a']);
        blocker.resolve(); await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(started).toEqual(['a', 'b']);
    });

    it('后续服务同步取消阻塞队首时，立即重新派发已越过的可运行模型', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const scheduler = createTranslationRequestScheduler(() => ({
            ...limits,
            serviceRequestLimits: {svc: {enabled: true, limits: {...limits, maxConcurrentTranslations: 2}}},
            modelRequestLimits: {svc: {a: {enabled: true, limits}, b: {enabled: true, limits}}},
        }));
        const activeGate = deferred<void>();
        const laterGate = deferred<void>();
        const active = scheduler.schedule(async () => activeGate.promise, {identity: {service: 'svc', model: 'a'}});
        const cancel = new AbortController();
        const blocked = scheduler.schedule(async () => 'never', {identity: {service: 'svc', model: 'a'}, signal: cancel.signal});
        const blockedOutcome = blocked.catch(error => error);
        const started: string[] = [];
        const ready = scheduler.schedule(async () => {started.push('ready');}, {identity: {service: 'svc', model: 'b'}});
        const later = scheduler.schedule(async () => {cancel.abort(); return laterGate.promise;}, {identity: {service: 'other'}});
        await flushMicrotasks();
        // 两个活动请求都没结束，没有新的 timer 或 promise settlement 替它再次唤醒。
        expect(started).toEqual(['ready']);
        expect(await blockedOutcome).toMatchObject({name: 'AbortError'});
        activeGate.resolve(); laterGate.resolve();
        await Promise.all([active, ready, later]);
    });

    it('真实 HTTP attempt 可越过同 bucket 的等待 provider，且仍在 attempt 间保持 FIFO', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 1, translationRequestsPerMinute: 0,
        }));
        const attempts: string[] = []; let attempt!: Promise<string>;
        const outer = scheduler.schedule(async () => {
            attempt = scheduler.scheduleAttempt(async () => { attempts.push('attempt'); return 'ok'; });
            return 'outer';
        }, {countRate: false});
        const waiting = scheduler.schedule(async () => { attempts.push('waiting'); return 'waiting'; });
        await expect(outer).resolves.toBe('outer');
        await expect(attempt).resolves.toBe('ok');
        expect(attempts).toEqual(['attempt']);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(waiting).resolves.toBe('waiting');
    });

    it('服务限制未启用或模型身份为空时回退 global bucket', async () => {
        const config = {
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
            serviceRequestLimits: {svc: {enabled: false, limits: {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}}},
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const blocker = deferred<void>();
        const first = scheduler.schedule(async () => blocker.promise, {identity: {service: 'svc'}});
        const second = scheduler.schedule(async () => 'second', {identity: {service: 'svc'}});
        await flushMicrotasks();
        blocker.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual([undefined, 'second']);
    });

    it('attempt 在已有并发任务和普通等待任务前仍可取得速率许可', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const blocker = deferred<void>();
        const active = scheduler.schedule(async () => blocker.promise);
        const waiting = scheduler.schedule(async () => 'waiting');
        const attempt = scheduler.scheduleAttempt(async () => 'attempt');
        await expect(attempt).resolves.toBe('attempt');
        blocker.resolve();
        await expect(Promise.all([active, waiting])).resolves.toEqual([undefined, 'waiting']);
    });

    it('等待速率许可的 attempt 按 FIFO 挡住同 bucket 的更晚 attempt，同轮扫描复用 bucket key', async () => {
        const limits = {maxConcurrentTranslations: 4, translationRequestsPerSecond: 1, translationRequestsPerMinute: 0};
        const scheduler = createTranslationRequestScheduler(() => ({
            ...limits,
            serviceRequestLimits: {svc: {enabled: true, limits}},
            modelRequestLimits: {svc: {m: {enabled: true, limits}}},
        }));
        const identity = {service: 'svc', model: 'm'};
        const order: string[] = [];
        const attempts: Promise<string>[] = [];
        const outer = scheduler.schedule(async () => {
            for (const name of ['first', 'second', 'third']) {
                attempts.push(scheduler.scheduleAttempt(async () => { order.push(name); return name; }, {identity}));
            }
            return 'outer';
        }, {identity, countRate: false});
        await expect(outer).resolves.toBe('outer');
        await flushMicrotasks();
        expect(order).toEqual(['first']);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(order).toEqual(['first', 'second']);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(Promise.all(attempts)).resolves.toEqual(['first', 'second', 'third']);
    });

    it('大量等待请求经过内部压缩后仍保持结果顺序', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const jobs = Array.from({length: 2_500}, (_, index) => scheduler.schedule(async () => index));
        await expect(Promise.all(jobs)).resolves.toEqual(Array.from({length: 2_500}, (_, index) => index));
    }, 10_000);

    it('超时和执行失败时都清理已注册的取消监听', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        const blocker = deferred<string>();
        const first = scheduler.schedule(async () => blocker.promise);
        const timedController = new AbortController();
        const timed = scheduler.schedule(async () => 'never', {
            signal: timedController.signal,
            deadlineAt: 100,
        });
        const timedOutcome = timed.catch((error) => error);

        await vi.advanceTimersByTimeAsync(100);
        await expect(timedOutcome).resolves.toBeInstanceOf(TranslationRequestSchedulerDeadlineError);
        blocker.resolve('done');
        await expect(first).resolves.toBe('done');

        const errorController = new AbortController();
        await expect(scheduler.schedule(async () => {
            throw new Error('scheduler task failed');
        }, {signal: errorController.signal})).rejects.toThrow('scheduler task failed');
    });

    it.each([false, true])('阻塞队列的大批入队和逐项取消只读取线性数量的请求身份（截止时间：%s）', async (withDeadlines) => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0,
            translationRequestsPerMinute: 0,
        }));
        let reads = 0;
        const identity = {get service() {reads += 1; return 'burst';}, model: 'm'};
        const blocker = deferred<void>();
        const active = scheduler.schedule(async () => blocker.promise, {identity});
        const controllers = Array.from({length: 4_000}, () => new AbortController());
        const waiting = controllers.map((controller, index) => {
            // 时钟正常推进不会解锁纯并发阻塞，不能因此退回整队扫描。
            vi.setSystemTime(index);
            return scheduler.schedule(async () => 'never', {identity, signal: controller.signal,
                ...(withDeadlines ? {deadlineAt: 45_000 + index} : {})})
                .catch(error => error.name);
        });
        const enqueueReads = reads;
        expect(enqueueReads).toBeLessThanOrEqual(controllers.length * 2 + 2);
        // 非最早 deadline 的取消无需重新排时；最早项最后取消仍会完整复核。
        (withDeadlines ? [...controllers].reverse() : controllers).forEach(controller => controller.abort());
        expect(reads - enqueueReads).toBeLessThanOrEqual(controllers.length);
        expect(await Promise.all(waiting)).toEqual(controllers.map(() => 'AbortError'));
        expect(vi.getTimerCount()).toBe(0);
        blocker.resolve();
        await active;
    });

    it('取消一种服务的最后等待项后，不让旧 FIFO 前沿阻塞新逻辑任务', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const scheduler = createTranslationRequestScheduler(() => ({...limits,
            serviceRequestLimits: {a: {enabled: true, limits}, b: {enabled: true, limits}},
        }));
        const firstGate = deferred<void>(), secondGate = deferred<void>();
        const first = scheduler.schedule(async () => firstGate.promise, {identity: {service: 'a'}});
        const second = scheduler.schedule(async () => secondGate.promise, {identity: {service: 'b'}});
        const controller = new AbortController();
        const removed = scheduler.schedule(async () => 'never', {identity: {service: 'b'}, signal: controller.signal})
            .catch(error => error.name);
        const waiting = scheduler.schedule(async () => 'later', {identity: {service: 'a'}});
        controller.abort();
        const task = vi.fn(async () => 'logical');
        const logical = scheduler.schedule(task, {identity: {service: 'b'}, countConcurrency: false});
        expect(task).toHaveBeenCalledTimes(1);
        expect(await removed).toBe('AbortError');
        expect(await logical).toBe('logical');
        firstGate.resolve(); secondGate.resolve();
        await Promise.all([first, second, waiting]);
    });

    it('增量入队保留旧速率唤醒并及时处理新条目的更早截止时间', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 1, translationRequestsPerSecond: 1, translationRequestsPerMinute: 0,
        }));
        await scheduler.schedule(async () => 'first');
        await flushMicrotasks();
        const order: string[] = [];
        const later = scheduler.schedule(async () => {order.push('later'); return 'later';});
        const expiredTask = vi.fn(async () => 'never');
        const expired = scheduler.schedule(expiredTask, {deadlineAt: 100}).catch(error => error.name);
        await vi.advanceTimersByTimeAsync(100);
        expect(await expired).toBe('TranslationRequestSchedulerDeadlineError');
        expect(expiredTask).not.toHaveBeenCalled();
        expect(order).toEqual([]);
        await vi.advanceTimersByTimeAsync(899);
        expect(order).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(await later).toBe('later');
        expect(order).toEqual(['later']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('配置原位修改会重建所有服务的等待前沿，而不只检查新条目', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config = {...limits, serviceRequestLimits: {
            a: {enabled: true, limits: {...limits}}, b: {enabled: true, limits: {...limits}},
        }};
        const scheduler = createTranslationRequestScheduler(() => config);
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise, {identity: {service: 'a'}});
        const ready = vi.fn(async () => 'ready');
        const waiting = scheduler.schedule(ready, {identity: {service: 'a'}});
        expect(ready).not.toHaveBeenCalled();
        config.serviceRequestLimits.a.limits.maxConcurrentTranslations = 2;
        const unrelated = scheduler.schedule(async () => 'other', {identity: {service: 'b'}});
        expect(ready).toHaveBeenCalledTimes(1);
        gate.resolve();
        await Promise.all([active, waiting, unrelated]);
    });

    it('增量入队立即拒绝已经过期的条目而不启动任务或遗留 timer', async () => {
        vi.setSystemTime(100);
        const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}));
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise);
        const expiredTask = vi.fn(async () => 'never');
        await expect(scheduler.schedule(expiredTask, {deadlineAt: 99}))
            .rejects.toBeInstanceOf(TranslationRequestSchedulerDeadlineError);
        expect(expiredTask).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        gate.resolve();
        await active;
    });

    it('旧直调 attempt 取消后清理其专用 FIFO 计数并保留下一次速率唤醒', async () => {
        const scheduler = createTranslationRequestScheduler(() => ({maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 1, translationRequestsPerMinute: 0}));
        await scheduler.scheduleAttempt(async () => 'prime');
        await flushMicrotasks();
        const controller = new AbortController();
        const cancelledTask = vi.fn(async () => 'never');
        const cancelled = scheduler.scheduleAttempt(cancelledTask, {signal: controller.signal}).catch(error => error.name);
        const nextTask = vi.fn(async () => 'next');
        const next = scheduler.scheduleAttempt(nextTask);
        controller.abort();
        expect(await cancelled).toBe('AbortError');
        await vi.advanceTimersByTimeAsync(999);
        expect(nextTask).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await next).toBe('next');
        expect(cancelledTask).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('配置重投影期间同步取消旧等待项，不留下过期的 bucket 引用', async () => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config: TranslationRequestSchedulerConfig = {...limits,
            // 持久化旧设置中的空模型项应按继承处理，而不是阻止全局调度。
            modelRequestLimits: {legacy: null as unknown as Record<string, never>}};
        const scheduler = createTranslationRequestScheduler(() => config);
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise, {identity: {service: 'a'}});
        const controller = new AbortController();
        const cancelledTask = vi.fn(async () => 'never');
        const waiting = scheduler.schedule(cancelledTask, {identity: {service: 'a'}, signal: controller.signal})
            .catch(error => error.name);
        config.serviceRequestLimits = {a: {enabled: true, limits}, b: {enabled: true, limits}};
        const unrelated = scheduler.schedule(async () => {controller.abort(); return 'b';}, {identity: {service: 'b'}});
        expect(await unrelated).toBe('b');
        expect(await waiting).toBe('AbortError');
        expect(cancelledTask).not.toHaveBeenCalled();
        gate.resolve();
        await active;
        await expect(scheduler.schedule(async () => 'next', {identity: {service: 'a'}})).resolves.toBe('next');
    });

    it.each(['config', 'clock'])('取消期间 %s 回调同步入队的其它服务立即调度，不等待无关传输释放', async (port) => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config = {...limits, serviceRequestLimits: {a: {enabled: true, limits}, b: {enabled: true, limits}}};
        let onRead: (() => void) | undefined;
        const read = () => {const callback = onRead; onRead = undefined; callback?.();};
        const scheduler = createTranslationRequestScheduler(() => {if (port === 'config') read(); return config;},
            {now: () => {if (port === 'clock') read(); return Date.now();}});
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise, {identity: {service: 'a'}});
        const controller = new AbortController();
        const cancelled = scheduler.schedule(async () => 'never', {identity: {service: 'a'}, signal: controller.signal})
            .catch(error => error.name);
        const independentTask = vi.fn(async () => 'b');
        let independent!: Promise<string>;
        onRead = () => {independent = scheduler.schedule(independentTask, {identity: {service: 'b'}});};
        controller.abort();
        try {
            expect(independentTask).toHaveBeenCalledTimes(1);
            expect(await independent).toBe('b');
            expect(await cancelled).toBe('AbortError');
        } finally {
            gate.resolve();
            await active;
        }
    });

    it('取消期间配置回调同步取消最早截止项，释放最后一个等待 timer', async () => {
        const earliest = new AbortController();
        const latest = new AbortController();
        let cancelDuringRead = false;
        const scheduler = createTranslationRequestScheduler(() => {
            if (cancelDuringRead) {cancelDuringRead = false; earliest.abort();}
            return {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        });
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise);
        const first = scheduler.schedule(async () => 'never', {deadlineAt: 100, signal: earliest.signal})
            .catch(error => error.name);
        const second = scheduler.schedule(async () => 'never', {signal: latest.signal})
            .catch(error => error.name);
        expect(vi.getTimerCount()).toBe(1);
        cancelDuringRead = true;
        latest.abort();
        expect(await Promise.all([first, second])).toEqual(['AbortError', 'AbortError']);
        expect(vi.getTimerCount()).toBe(0);
        gate.resolve();
        await active;
    });

    it.each(['config', 'clock'])('追加期间 %s 回调同步入队仍保持外层先到的 FIFO 顺序', async (port) => {
        const limits = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};
        const config = {...limits, serviceRequestLimits: {a: {enabled: true, limits}, b: {enabled: true, limits}}};
        let onRead: (() => void) | undefined;
        const read = () => {const callback = onRead; onRead = undefined; callback?.();};
        const scheduler = createTranslationRequestScheduler(() => {if (port === 'config') read(); return config;},
            {now: () => {if (port === 'clock') read(); return Date.now();}});
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise, {identity: {service: 'a'}});
        const order: string[] = [];
        let nested!: Promise<void>;
        onRead = () => {nested = scheduler.schedule(async () => {order.push('nested');}, {identity: {service: 'b'}});};
        const outer = scheduler.schedule(async () => {order.push('outer');}, {identity: {service: 'b'}});
        try {
            expect(order).toEqual(['outer']);
            await Promise.all([outer, nested]);
            expect(order).toEqual(['outer', 'nested']);
        } finally {
            gate.resolve();
            await active;
        }
    });


    it('无冷却响应推进时钟后，时钟回退仍清除旧速率和等待前沿', async () => {
        vi.setSystemTime(100);
        const scheduler = createTranslationRequestScheduler(() => ({
            maxConcurrentTranslations: 2, translationRequestsPerSecond: 1, translationRequestsPerMinute: 0,
        }));
        await scheduler.schedule(async () => 'first');
        await flushMicrotasks();
        const controller = new AbortController();
        const secondTask = vi.fn(async () => 'second');
        const second = scheduler.schedule(secondTask, {signal: controller.signal});
        vi.setSystemTime(200);
        scheduler.observeResponse({quotaScope: 'scope'}, {status: 503, headers: new Headers()});
        vi.setSystemTime(150);
        const third = scheduler.schedule(async () => 'third', {signal: controller.signal})
            .catch(error => error.name);
        expect(secondTask).toHaveBeenCalledTimes(1);
        expect(await second).toBe('second');
        controller.abort();
        expect(await third).toBe('AbortError');
        expect(vi.getTimerCount()).toBe(0);
    });


    it('取消最早截止项后撤掉旧 timer，保留剩余条目的准确唤醒时间', async () => {
        const readConfig = vi.fn(() => ({maxConcurrentTranslations: 1,
            translationRequestsPerSecond: 0, translationRequestsPerMinute: 0}));
        const scheduler = createTranslationRequestScheduler(readConfig);
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise);
        const controller = new AbortController();
        const earliest = scheduler.schedule(async () => 'never', {signal: controller.signal, deadlineAt: 100})
            .catch(error => error.name);
        const later = scheduler.schedule(async () => 'never', {deadlineAt: 200})
            .catch(error => error.name);
        controller.abort();
        expect(await earliest).toBe('AbortError');
        readConfig.mockClear();
        await vi.advanceTimersByTimeAsync(100);
        expect(readConfig).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(await later).toBe('TranslationRequestSchedulerDeadlineError');
        gate.resolve();
        await active;
    });


    it.each([500, 1_000, 1_500])('FIFO 后方模型在 %i ms 取消前项后按速率恢复时间启动', async (cancelAt) => {
        const limits = (concurrency: number, rate = 0) => ({maxConcurrentTranslations: concurrency,
            translationRequestsPerSecond: rate, translationRequestsPerMinute: 0});
        const scheduler = createTranslationRequestScheduler(() => ({...limits(3),
            serviceRequestLimits: {svc: {enabled: true, limits: limits(3)}},
            modelRequestLimits: {svc: {a: {enabled: true, limits: limits(1)}, b: {enabled: true, limits: limits(1, 1)}}},
        }));
        const gate = deferred<void>();
        const active = scheduler.schedule(async () => gate.promise, {identity: {service: 'svc', model: 'a'}});
        await scheduler.schedule(async () => 'prime-rate', {identity: {service: 'svc', model: 'b'}});
        await flushMicrotasks();
        const controller = new AbortController();
        const first = scheduler.schedule(async () => 'never', {identity: {service: 'svc', model: 'a'}, signal: controller.signal})
            .catch(error => error.name);
        const ready = vi.fn(async () => 'ready');
        const second = scheduler.schedule(ready, {identity: {service: 'svc', model: 'b'}});
        expect(vi.getTimerCount()).toBe(0);
        vi.setSystemTime(cancelAt);
        controller.abort();
        if (cancelAt < 1_000) {
            expect(ready).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(1_000 - cancelAt - 1);
            expect(ready).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
        }
        expect(ready).toHaveBeenCalledTimes(1);
        expect(await first).toBe('AbortError');
        expect(await second).toBe('ready');
        expect(vi.getTimerCount()).toBe(0);
        gate.resolve();
        await active;
    });

});

function schedulerForLeaseTest(
    task: (lease: {holdUntil: (settlement: PromiseLike<unknown>) => void}) => Promise<string>,
): Promise<string> {
    return createTranslationRequestScheduler(() => ({
        maxConcurrentTranslations: 1,
        translationRequestsPerSecond: 0,
        translationRequestsPerMinute: 0,
    })).schedule(task);
}
