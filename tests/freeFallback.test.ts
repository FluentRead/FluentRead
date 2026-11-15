import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createFreeFallbackRunner, UntranslatedFreeResultError, WrongLanguageFreeResultError, type FreeFallbackAttempt, type FreeFallbackCandidate, type FreeFallbackLease} from '@/src/services/translation/freeFallback';
import {serializeTranslationError} from '@/src/services/translation/errors';

const options = {timeoutMs: 100, cooldownMs: 1_000};
const failure = (statusCode: number) => Object.assign(new Error('secret text https://secret.example/?key=hidden'), {statusCode});
const candidate = (identity: string, translate = vi.fn().mockResolvedValue(`译:${identity}`)): FreeFallbackCandidate => ({identity, label: identity, translate});
const flush = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };
function deferred<T = string>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return {promise, resolve, reject};
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('free provider fallback coordinator', () => {
    it('keeps every live route lease when all health entries are busy at the eviction limit', async () => {
        const run=createFreeFallbackRunner(129),gates=Array.from({length:129},()=>deferred<string>());
        const routes=gates.map((gate,index)=>candidate(`busy-${index}`,vi.fn(()=>gate.promise)));
        const requests:Promise<string>[]=[];
        for(const route of routes){requests.push(run([route],{...options,timeoutMs:10_000}));await flush();}
        expect(routes.every(route=>vi.mocked(route.translate).mock.calls.length===1)).toBe(true);
        gates.forEach((gate,index)=>gate.resolve(`译文 ${index}`));
        await expect(Promise.all(requests)).resolves.toEqual(gates.map((_,index)=>`译文 ${index}`));
        expect(vi.getTimerCount()).toBe(0);
    });
    it('reports the earliest temporary recovery without repeating the pool or borrowing permanent routes', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const routes = [
            candidate('quota', vi.fn().mockRejectedValue(Object.assign(failure(402), {retryAfterMs: 1000}))),
            candidate('blocked', vi.fn().mockRejectedValue(Object.assign(failure(403), {retryAfterMs: 1000}))),
            candidate('limited', vi.fn().mockRejectedValue(Object.assign(failure(429), {retryAfterMs: 5000}))),
            candidate('temporary', vi.fn().mockRejectedValueOnce(Object.assign(failure(503), {retryAfterMs: 2000})).mockResolvedValue('恢复后的译文')),
            candidate('request', vi.fn().mockRejectedValue(failure(400))),
        ];
        const result = await run(routes, options).catch(serializeTranslationError);
        expect(result).toMatchObject({code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', kind: 'provider', retryable: false, retryAfterMs: 2000});
        await expect(run(routes, options)).rejects.toMatchObject({code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryAfterMs: 2000, retryable: false});
        expect(routes.slice(0, 4).every(route => vi.mocked(route.translate).mock.calls.length === 1)).toBe(true);
        expect(routes[4].translate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000);
        await expect(run(routes, options)).resolves.toBe('恢复后的译文');
        expect(routes[3].translate).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the remaining rate-limit recovery hint while every selected route is cooling', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const route = candidate('limited', vi.fn().mockRejectedValue(Object.assign(failure(429), {retryAfterMs: 5000})));
        await expect(run([route], options)).rejects.toMatchObject({kind: 'rate-limit', retryable: false,
            code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryAfterMs: 5000});
        await vi.advanceTimersByTimeAsync(1000);
        await expect(run([route], options)).rejects.toMatchObject({kind: 'rate-limit', retryAfterMs: 4000,
            code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryable: false});
        expect(route.translate).toHaveBeenCalledOnce();
    });

    it.each([400, 401, 402, 403, 404, 410, 456, new UntranslatedFreeResultError(), new WrongLanguageFreeResultError()])
        ('does not advertise temporary recovery for a permanent or text-specific failure: %s', async status => {
            const run = createFreeFallbackRunner(3, {random: () => 0});
            const route = candidate('permanent', vi.fn().mockRejectedValue(typeof status === 'number' ? failure(status) : status));
            const error = await run([route], options).catch(serializeTranslationError);
            expect(error).toMatchObject({kind: 'provider', retryable: false});
            expect(error).not.toHaveProperty('code', 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE');
            expect((error as {retryAfterMs?: number}).retryAfterMs).toBeUndefined();
        });

    it('does not let a request error inherit recovery from an earlier temporary failure or an empty pool', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const route = candidate('changed', vi.fn().mockRejectedValueOnce(failure(503)).mockRejectedValue(failure(400)));
        await expect(run([route], options)).rejects.toHaveProperty('code', 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE');
        await vi.advanceTimersByTimeAsync(1000);
        const error = await run([route], options).catch(serializeTranslationError);
        expect((error as {code?: string}).code).toBeUndefined();
        const empty = await run([], options).catch(serializeTranslationError);
        expect((empty as {code?: string}).code).toBeUndefined();
        expect((empty as {retryAfterMs?: number}).retryAfterMs).toBeUndefined();
    });

    it('provides a bounded recovery hint on real total timeout but excludes a pool with only blocked routes', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const route = candidate('slow', vi.fn(() => new Promise(() => undefined)));
        const request = run([route], {...options, timeoutMs: 5000, deadline: Date.now() + 1000});
        const outcome = expect(request).rejects.toMatchObject({kind: 'timeout', retryable: false,
            code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryAfterMs: 1000});
        await vi.advanceTimersByTimeAsync(1000);await outcome;
        expect(route.translate).toHaveBeenCalledOnce();
        expect(vi.mocked(route.translate).mock.calls[0][0].aborted).toBe(true);
        const blocked = candidate('blocked', vi.fn().mockRejectedValue(failure(403)));
        await expect(run([blocked], options)).rejects.toMatchObject({kind: 'provider'});
        const expired = await run([blocked], {...options, deadline: Date.now()}).catch(serializeTranslationError);
        expect(expired).toMatchObject({kind: 'timeout', retryable: false});
        expect((expired as {code?: string}).code).toBeUndefined();
    });

    it('超时会中止不响应的服务并在预算内进入下一服务', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        let signal!: AbortSignal;
        const first = candidate('first', vi.fn((received: AbortSignal) => {
            signal = received;
            return new Promise(() => {});
        }));
        const second = candidate('second');
        const request = run([first, second], options);
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        await expect(request).resolves.toBe('译:second');
        expect(signal.aborted).toBe(true);
        expect(second.translate).toHaveBeenCalledOnce();
    });

    it('逐次线路尝试按成功、失败、超时和取消上报身份与耗时', async () => {
        const attempts: FreeFallbackAttempt[] = [];
        const onAttempt = (attempt: FreeFallbackAttempt) => attempts.push(attempt);

        const failing = createFreeFallbackRunner(3, {random: () => 0});
        await expect(failing([
            candidate('first', vi.fn().mockRejectedValue(failure(500))),
            candidate('second'),
        ], {...options, onAttempt})).resolves.toBe('译:second');

        const timing = createFreeFallbackRunner(3, {random: () => 0});
        const pendingRequest = timing([
            candidate('slow', vi.fn(() => new Promise(() => {}))),
            candidate('quick'),
        ], {...options, onAttempt});
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        await expect(pendingRequest).resolves.toBe('译:quick');

        const cancelling = createFreeFallbackRunner(3, {random: () => 0});
        const controller = new AbortController();
        const cancelled = cancelling([candidate('cancelled', vi.fn(() => new Promise(() => {})))], {...options, onAttempt, signal: controller.signal});
        const rejection = expect(cancelled).rejects.toThrow('用户取消');
        await flush();
        controller.abort(new Error('用户取消'));
        await rejection;

        expect(attempts).toEqual([
            {identity: 'first', outcome: 'error', durationMs: expect.any(Number)},
            {identity: 'second', outcome: 'success', durationMs: expect.any(Number)},
            {identity: 'slow', outcome: 'timeout', durationMs: 100},
            {identity: 'quick', outcome: 'success', durationMs: expect.any(Number)},
            {identity: 'cancelled', outcome: 'cancelled', durationMs: expect.any(Number)},
        ]);
    });

    it('429 后跨段跳过冷却服务，到期仅探测一次，成功恢复正常优先级', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockRejectedValueOnce(failure(429)).mockResolvedValue('恢复'));
        const second = candidate('second');
        await expect(run([first, second], options)).resolves.toBe('译:second');
        await expect(run([first, second], options)).resolves.toBe('译:second');
        expect(first.translate).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(300_000);
        await expect(run([first, second], options)).resolves.toBe('恢复');
        await expect(run([first, second], options)).resolves.toBe('恢复');
        expect(first.translate).toHaveBeenCalledTimes(3);
    });

    it.each([400, 413, 415, 422])('HTTP %i 的文本或语言失败不熔断后续文本', async status => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockRejectedValueOnce(failure(status)).mockResolvedValue('正常'));
        const second = candidate('second');
        await expect(run([first, second], options)).resolves.toBe('译:second');
        await expect(run([first, second], options)).resolves.toBe('正常');
        expect(first.translate).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 408, 429, 456, 500, 503])('HTTP %i 对相同连接启用冷却', async status => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockRejectedValue(failure(status)));
        await expect(run([first], options)).rejects.toThrow(`HTTP ${status}`);
        await expect(run([first], options)).rejects.toThrow('正在冷却');
        expect(first.translate).toHaveBeenCalledOnce();
    });

    it.each(['', '   ', undefined, ['unexpected'], {text: 'unexpected'}])('无效响应进入冷却且继续备用服务 %#', async value => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockResolvedValue(value));
        const second = candidate('second');
        await expect(run([first, second], options)).resolves.toBe('译:second');
        await expect(run([first, second], options)).resolves.toBe('译:second');
        expect(first.translate).toHaveBeenCalledOnce();
    });

    it('同服务更换身份后独立探测，旧身份仍保持冷却', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const old = candidate('hash-old', vi.fn().mockRejectedValue(failure(429)));
        await expect(run([old], options)).rejects.toThrow('HTTP 429');
        await expect(run([candidate('hash-new')], options)).resolves.toBe('译:hash-new');
        await expect(run([old], options)).rejects.toThrow('正在冷却');
        expect(old.translate).toHaveBeenCalledOnce();
    });

    it('全冷却时立即给出清晰错误且不重新发请求', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const candidates = [candidate('a', vi.fn().mockRejectedValue(failure(429))), candidate('b', vi.fn().mockRejectedValue(failure(503)))];
        await expect(run(candidates, options)).rejects.toThrow('免费翻译服务均不可用');
        await expect(run(candidates, options)).rejects.toThrow('所选服务正在冷却，请稍后重试');
        candidates.forEach(item => expect(item.translate).toHaveBeenCalledOnce());
    });

    it('冷却到期的并发请求只放行一个探测', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const pending = deferred();
        const first = candidate('first', vi.fn().mockRejectedValueOnce(failure(429)).mockImplementation(() => pending.promise));
        const second = candidate('second');
        await run([first, second], options);
        await vi.advanceTimersByTimeAsync(300_000);
        const probe = run([first, second], options);
        await flush();
        await expect(run([first, second], options)).resolves.toBe('译:second');
        expect(first.translate).toHaveBeenCalledTimes(2);
        pending.resolve('恢复');
        await expect(probe).resolves.toBe('恢复');
    });

    it('成功后的旧并发失败不能重新打开冷却', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const pending = deferred();
        const first = candidate('first', vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue('正常'));
        const second = candidate('second');
        const old = run([first, second], options);
        await flush();
        await expect(run([first, second], options)).resolves.toBe('正常');
        pending.reject(failure(503));
        await expect(old).resolves.toBe('译:second');
        await expect(run([first, second], options)).resolves.toBe('正常');
        expect(first.translate).toHaveBeenCalledTimes(3);
    });

    it('新限流不能被更早发出的成功响应解除，已完成译文仍交付原调用者', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const pending = deferred();
        const first = candidate('first', vi.fn().mockImplementationOnce(() => pending.promise)
            .mockRejectedValueOnce(Object.assign(failure(429), {retryAfterMs: 5000})).mockResolvedValue('恢复'));
        const second = candidate('second');
        const old = run([first, second], options);
        await flush();
        await expect(run([first, second], options)).resolves.toBe('译:second');
        const limited = (await run.getHealthSnapshot()).find(item => item.identity === 'first');
        expect(limited).toMatchObject({failures: 1, category: 'rate-limit'});
        pending.resolve('早发请求的完整译文');
        await expect(old).resolves.toBe('早发请求的完整译文');
        expect((await run.getHealthSnapshot()).find(item => item.identity === 'first')).toMatchObject({
            failures: limited!.failures, retryAt: limited!.retryAt, category: limited!.category,
        });
        await expect(run([first, second], options)).resolves.toBe('译:second');
        expect(first.translate).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(5000);
        await expect(run([first, second], options)).resolves.toBe('恢复');
        expect(first.translate).toHaveBeenCalledTimes(3);
    });

    it('超时的迟到成功不能提前清除冷却', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const pending = deferred();
        const first = candidate('first', vi.fn(() => pending.promise));
        const second = candidate('second');
        const request = run([first, second], options);
        await vi.advanceTimersByTimeAsync(100);
        await expect(request).resolves.toBe('译:second');
        pending.resolve('迟到');
        await flush();
        await expect(run([first, second], options)).resolves.toBe('译:second');
        expect(first.translate).toHaveBeenCalledOnce();
    });

    it('调用方取消立即结束忽略 signal 的请求，不降级也不计失败', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const controller = new AbortController();
        const first = candidate('first', vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue('正常'));
        const second = candidate('second');
        const request = run([first, second], {...options, signal: controller.signal});
        const assertion = expect(request).rejects.toThrow('用户取消');
        await flush();
        controller.abort(new Error('用户取消'));
        await assertion;
        expect(second.translate).not.toHaveBeenCalled();
        await expect(run([first, second], options)).resolves.toBe('正常');
    });

    it('provider 主动取消不降级也不冷却', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockRejectedValueOnce(new DOMException('cancelled', 'AbortError')).mockResolvedValue('正常'));
        const second = candidate('second');
        await expect(run([first, second], options)).rejects.toMatchObject({name: 'AbortError'});
        expect(second.translate).not.toHaveBeenCalled();
        await expect(run([first], options)).resolves.toBe('正常');
    });

    it('已取消、已过期或无已配置服务时不调用 provider', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first');
        const controller = new AbortController();
        controller.abort();
        await expect(run([first], {...options, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        await expect(run([first], {...options, deadline: Date.now()})).rejects.toThrow('请求超时');
        await expect(run([], options)).rejects.toThrow('未选择可用的免密钥服务');
        expect(first.translate).not.toHaveBeenCalled();
    });

    it('获得并发许可后、执行服务前的取消立即生效', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first');
        const controller = new AbortController();
        const request = run([first], {...options, signal: controller.signal});
        controller.abort();
        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(first.translate).not.toHaveBeenCalled();
        await expect(run([first], options)).resolves.toBe('译:first');
    });

    it('服务回调排入微任务后、实际执行前的取消不产生网络请求', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first');
        const controller = new AbortController();
        const request = run([first], {...options, signal: controller.signal});
        await Promise.resolve();
        controller.abort();
        await expect(request).rejects.toMatchObject({name: 'AbortError'});
        expect(first.translate).not.toHaveBeenCalled();
    });

    it('获得并发许可时已经耗尽总预算，不执行服务', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first');
        const request = run([first], {...options, deadline: Date.now() + 10});
        vi.setSystemTime(Date.now() + 10);
        await expect(request).rejects.toThrow('请求超时');
        expect(first.translate).not.toHaveBeenCalled();
    });

    it('服务刚成功但结果尚未交付时，取消仍优先且不改变健康状态', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const pending = deferred();
        const first = candidate('first', vi.fn(() => pending.promise));
        const controller = new AbortController();
        const request = run([first], {...options, signal: controller.signal});
        await flush();
        pending.resolve('完成');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        await expect(request).rejects.toMatchObject({name: 'AbortError'});
    });

    it('配置身份缓存有界，只淘汰最久未使用的健康记录', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const oldest = candidate('oldest', vi.fn().mockRejectedValueOnce(failure(429)).mockResolvedValue('重新探测'));
        const recent = candidate('recent', vi.fn().mockRejectedValue(failure(429)));
        await expect(run([oldest], options)).rejects.toThrow('HTTP 429');
        await expect(run([recent], options)).rejects.toThrow('HTTP 429');
        for (let index = 0; index < 127; index += 1) await run([candidate(`other-${index}`)], options);
        await expect(run([recent], options)).rejects.toThrow('正在冷却');
        await expect(run([oldest], options)).resolves.toBe('重新探测');
        expect(recent.translate).toHaveBeenCalledOnce();
    });

    it('整个请求的剩余预算限制备用服务时间', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn(() => new Promise(() => {})));
        const second = candidate('second', vi.fn(() => new Promise(() => {})));
        const third = candidate('third');
        const request = run([first, second, third], {...options, deadline: Date.now() + 150});
        const assertion = expect(request).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(150);
        await assertion;
        expect(first.translate).toHaveBeenCalledOnce();
        expect(second.translate).toHaveBeenCalledOnce();
        expect(third.translate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('上层总预算提前用完不应把仍在正常时限内的服务标为故障', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = candidate('first', vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue('正常'));
        const request = run([first], {...options, deadline: Date.now() + 20});
        const assertion = expect(request).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(20);
        await assertion;
        await expect(run([first], options)).resolves.toBe('正常');
        expect(first.translate).toHaveBeenCalledTimes(2);
    });

    it('多个独立单文本请求共享并发上限，队列取消不占用后续许可', async () => {
        const run = createFreeFallbackRunner(2);
        const pending = [deferred(), deferred(), deferred()];
        const first = candidate('first', vi.fn()
            .mockImplementationOnce(() => pending[0].promise)
            .mockImplementationOnce(() => pending[1].promise)
            .mockImplementationOnce(() => pending[2].promise));
        const firstRequest = run([first], options);
        const secondRequest = run([first], options);
        const cancelled = new AbortController();
        const cancelledRequest = run([first], {...options, signal: cancelled.signal});
        const cancelledAssertion = expect(cancelledRequest).rejects.toMatchObject({name: 'AbortError'});
        const lastRequest = run([first], options);
        await flush();
        expect(first.translate).toHaveBeenCalledTimes(2);
        cancelled.abort();
        await cancelledAssertion;
        pending[0].resolve('first');
        await expect(firstRequest).resolves.toBe('first');
        await flush();
        expect(first.translate).toHaveBeenCalledTimes(3);
        pending[1].resolve('second');
        pending[2].resolve('last');
        await expect(secondRequest).resolves.toBe('second');
        await expect(lastRequest).resolves.toBe('last');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('排队时间也计入总预算，队列超时不会造成 provider 冷却', async () => {
        const run = createFreeFallbackRunner(1);
        const pending = deferred();
        const first = candidate('first', vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue('正常'));
        const active = run([first], options);
        const waiting = run([first], {...options, deadline: Date.now() + 50});
        const assertion = expect(waiting).rejects.toThrow('请求超时');
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        expect(first.translate).toHaveBeenCalledOnce();
        pending.resolve('完成');
        await active;
        await expect(run([first], options)).resolves.toBe('正常');
    });

    it('只汇总安全错误分类，不泄漏原文、密钥或完整 endpoint', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const unknown = candidate('网络服务', vi.fn().mockRejectedValue('ORIGINAL key=secret https://sensitive.example/'));
        const known = candidate('限流服务', vi.fn().mockRejectedValue(failure(429)));
        await expect(run([unknown, known], options)).rejects.toThrow('网络服务: 请求失败；限流服务: HTTP 429');
        await expect(run([candidate('other', vi.fn().mockRejectedValue(new Error('key=secret')))], options))
            .rejects.not.toThrow('secret');
    });
});

describe('free fallback retains actual transport capacity after public cancellation', () => {
    const lifetimeOptions = {mode: 'sequential' as const, timeoutMs: 1_000, cooldownMs: 1_000};

    it.each(['cancel', 'deadline'] as const)('rechecks %s after candidate capacity inspection before reserving total capacity', async stop => {
        const run = createFreeFallbackRunner(1);
        const owner = new AbortController();
        const deadline = Date.now() + 100;
        const source = {
            ...candidate('pre-admission'),
            get maxConcurrency() {
                if (stop === 'cancel') owner.abort();
                else vi.setSystemTime(deadline);
                return 1;
            },
        };
        const request = run([source], {...lifetimeOptions, deadline, signal: owner.signal});
        await expect(request).rejects.toMatchObject(stop === 'cancel' ? {name: 'AbortError'} : {kind: 'timeout'});
        expect(source.translate).not.toHaveBeenCalled();
        await expect(run([candidate('after-admission-stop')], lifetimeOptions)).resolves.toBe('译:after-admission-stop');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancellation during attempt preparation stops the raw callback and returns its reserved capacity', async () => {
        const run = createFreeFallbackRunner(1);
        const owner = new AbortController();
        const source = {
            ...candidate('pre-execution'),
            get minIntervalMs() { owner.abort(); return 0; },
        };
        await expect(run([source], {...lifetimeOptions, signal: owner.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(source.translate).not.toHaveBeenCalled();
        await expect(run([candidate('after-pre-execution')], lifetimeOptions)).resolves.toBe('译:after-pre-execution');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['primary', 'hedge'] as const)('a closed outer lease rejects the %s before raw execution without leaking capacity or owner listeners', async refused => {
        const run = createFreeFallbackRunner(2, {random: () => 0});
        const owner = new AbortController();
        const remove = vi.spyOn(owner.signal, 'removeEventListener');
        const raw = deferred();
        const primary = candidate('lease-primary', vi.fn(() => raw.promise));
        const backup = candidate('lease-backup');
        const refusedLease = new Error('outer request lease is closed');
        let registrations = 0;
        const held: PromiseLike<unknown>[] = [];
        const request = run([primary, backup], {
            ...lifetimeOptions, timeoutMs: 5_000, mode: 'balanced', signal: owner.signal,
            lease: {holdUntil(settlement) {
                registrations += 1;
                if (registrations === (refused === 'primary' ? 1 : 2)) throw refusedLease;
                held.push(settlement);
            }},
        }).catch(error => error);
        await vi.advanceTimersByTimeAsync(refused === 'primary' ? 0 : 1_500);
        await expect(request).resolves.toBe(refusedLease);
        expect(primary.translate).toHaveBeenCalledTimes(refused === 'primary' ? 0 : 1);
        expect(backup.translate).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(await run.getHealthSnapshot()).toEqual([]);

        raw.resolve('ignored cancelled primary');
        await Promise.all(held);
        const occupiedOne = deferred();
        const occupiedTwo = deferred();
        const first = run([candidate('after-refusal-one', vi.fn(() => occupiedOne.promise))], lifetimeOptions);
        const second = run([candidate('after-refusal-two', vi.fn(() => occupiedTwo.promise))], lifetimeOptions);
        const third = candidate('after-refusal-three');
        const queued = run([third], lifetimeOptions);
        await vi.advanceTimersByTimeAsync(0);
        expect(third.translate).not.toHaveBeenCalled();
        occupiedOne.resolve('one');
        occupiedTwo.resolve('two');
        await expect(first).resolves.toBe('one');
        await expect(second).resolves.toBe('two');
        await expect(queued).resolves.toBe('译:after-refusal-three');
        expect(vi.getTimerCount()).toBe(0);
        remove.mockRestore();
    });

    it.each(['resolve', 'reject'] as const)('keeps the total permit until a cancelled transport really %s', async end => {
        const run = createFreeFallbackRunner(1);
        const transport = deferred();
        const controller = new AbortController();
        const held: Promise<void>[] = [];
        let heldSettled = false;
        const first = run([candidate('cancelled-physical', vi.fn(() => transport.promise))], {
            ...lifetimeOptions, signal: controller.signal,
            lease: {holdUntil: settlement => {held.push(Promise.resolve(settlement).then(() => {heldSettled = true;}));}},
        }).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(held).toHaveLength(1);
        controller.abort();
        await expect(first).resolves.toMatchObject({name: 'AbortError'});
        const next = candidate('another-physical');
        const waiting = run([next], lifetimeOptions);
        await vi.advanceTimersByTimeAsync(0);
        expect(next.translate).not.toHaveBeenCalled();
        expect(heldSettled).toBe(false);
        if (end === 'resolve') transport.resolve('ignored late translation');
        else transport.reject(new TypeError('late physical failure'));
        await expect(waiting).resolves.toBe('译:another-physical');
        await Promise.all(held);
        expect(heldSettled).toBe(true);
        expect(await run.getHealthSnapshot()).toEqual([
            expect.objectContaining({identity: 'another-physical', failures: 0}),
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the cancelled candidate full while independent candidates still use spare capacity', async () => {
        const run = createFreeFallbackRunner(2);
        const transport = deferred();
        const controller = new AbortController();
        const limited = {...candidate('limited-late', vi.fn().mockImplementationOnce(() => transport.promise).mockResolvedValue('resumed')), maxConcurrency: 1};
        const first = run([limited], {...lifetimeOptions, signal: controller.signal}).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await expect(first).resolves.toMatchObject({name: 'AbortError'});
        const waiting = run([limited], lifetimeOptions);
        const alternate = candidate('independent');
        await expect(run([alternate], lifetimeOptions)).resolves.toBe('译:independent');
        expect(limited.translate).toHaveBeenCalledOnce();
        transport.resolve('ignored cancelled result');
        await expect(waiting).resolves.toBe('resumed');
        expect(limited.translate).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a timed-out primary keeps its permit while the fallback uses a separate available permit', async () => {
        const run = createFreeFallbackRunner(2);
        const slow = deferred();
        const backup = deferred();
        const held: PromiseLike<unknown>[] = [];
        const request = run([
            candidate('late-timeout', vi.fn(() => slow.promise)),
            candidate('backup-live', vi.fn(() => backup.promise)),
        ], {...lifetimeOptions, timeoutMs: 100, lease: {holdUntil: promise => {held.push(promise);}}});
        await vi.advanceTimersByTimeAsync(100);
        const third = candidate('third-live');
        const waiting = run([third], lifetimeOptions);
        await vi.advanceTimersByTimeAsync(0);
        expect(third.translate).not.toHaveBeenCalled();
        expect(held).toHaveLength(2);
        backup.resolve('backup success');
        await expect(request).resolves.toBe('backup success');
        await expect(waiting).resolves.toBe('译:third-live');
        const healthBeforeLate = await run.getHealthSnapshot();
        expect(healthBeforeLate.find(item => item.identity === 'late-timeout')).toMatchObject({failures: 1});
        slow.resolve('a late result must not clear the timeout cooldown');
        await Promise.all(held);
        expect(await run.getHealthSnapshot()).toEqual(healthBeforeLate);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a saturated fallback exits at the original deadline without freeing the old transport', async () => {
        const run = createFreeFallbackRunner(1);
        const slow = deferred();
        const backup = candidate('blocked-backup');
        const request = run([candidate('still-live', vi.fn(() => slow.promise)), backup], {
            ...lifetimeOptions, timeoutMs: 100, deadline: Date.now() + 300,
        }).catch(error => error);
        await vi.advanceTimersByTimeAsync(300);
        await expect(request).resolves.toMatchObject({kind: 'timeout'});
        expect(backup.translate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        slow.resolve('late settlement');
        await vi.advanceTimersByTimeAsync(0);
        await expect(run([backup], lifetimeOptions)).resolves.toBe('译:blocked-backup');
    });

    it('nested transport holds survive an early candidate rejection and release on physical settlement', async () => {
        const run = createFreeFallbackRunner(1);
        const raw = deferred();
        const controller = new AbortController();
        let candidateLease!: FreeFallbackLease;
        const source = candidate('nested-transport', vi.fn((signal: AbortSignal, lease: FreeFallbackLease) => {
            candidateLease = lease;
            lease.holdUntil(raw.promise);
            return new Promise<string>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
            });
        }));
        const cancelled = run([source], {...lifetimeOptions, signal: controller.signal}).catch(error => error);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await expect(cancelled).resolves.toMatchObject({name: 'AbortError'});
        const next = candidate('after-nested');
        const waiting = run([next], lifetimeOptions);
        await vi.advanceTimersByTimeAsync(0);
        expect(next.translate).not.toHaveBeenCalled();
        expect(() => candidateLease.holdUntil(Promise.resolve())).toThrow('线路已结束');
        raw.reject(new TypeError('physical request finally stopped'));
        await expect(waiting).resolves.toBe('译:after-nested');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never adds a hedge beyond the total transport capacity', async () => {
        const run = createFreeFallbackRunner(1, {random: () => 0});
        const primary = deferred();
        const backup = candidate('spare-without-capacity');
        const request = run([candidate('only-slot', vi.fn(() => primary.promise)), backup], {
            ...lifetimeOptions, mode: 'balanced', timeoutMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(backup.translate).not.toHaveBeenCalled();
        primary.resolve('primary result');
        await expect(request).resolves.toBe('primary result');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('holds hedge ownership until the ignored loser settles even after credit is refilled', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const loser = deferred();
        const first = run([candidate('hedge-loser', vi.fn(() => loser.promise)), candidate('hedge-winner')], {
            ...lifetimeOptions, mode: 'balanced', timeoutMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(1_500);
        await expect(first).resolves.toBe('译:hedge-winner');
        for (let index = 0; index < 4; index += 1) await run([candidate(`refill-${index}`)], lifetimeOptions);
        const primary = deferred();
        const backup = candidate('second-hedge');
        const next = run([candidate('next-primary', vi.fn(() => primary.promise)), backup], {
            ...lifetimeOptions, mode: 'balanced', timeoutMs: 5_000,
        });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(backup.translate).not.toHaveBeenCalled();
        primary.resolve('next primary');
        await expect(next).resolves.toBe('next primary');
        loser.resolve('ignored loser');
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('speed-first free routing', () => {
    const fastOptions = {mode: 'balanced' as const, timeoutMs: 5000, cooldownMs: 1000};
    const delayed = (id: string, ms: number, reject = false) => candidate(id, vi.fn(() => new Promise<string>((resolve, fail) => {
        setTimeout(() => reject ? fail(failure(503)) : resolve(`译:${id}`), ms);
    })));

    it('returns the backup at 1.6s instead of waiting 5s, cancelling the loser without a failure', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const slow = candidate('slow', vi.fn(() => new Promise(() => undefined)));
        const backup = delayed('backup', 100);
        const events: FreeFallbackAttempt[] = [];
        const request = run([slow, backup], {...fastOptions, onAttempt: event => events.push(event)});
        await vi.advanceTimersByTimeAsync(1499);
        expect(backup.translate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(101);
        await expect(request).resolves.toBe('译:backup');
        expect(vi.mocked(slow.translate).mock.calls[0][0].aborted).toBe(true);
        expect(events.map(item => [item.identity, item.outcome])).toEqual([['backup', 'success'], ['slow', 'cancelled']]);
        expect((await run.getHealthSnapshot()).some(item => item.identity === 'slow')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps fast requests single and switches immediately on a real failure', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const backup = candidate('backup');
        await expect(run([candidate('fast'), backup], fastOptions)).resolves.toBe('译:fast');
        expect(backup.translate).not.toHaveBeenCalled();
        await expect(run([candidate('failed', vi.fn().mockRejectedValue(failure(503))), backup], fastOptions)).resolves.toBe('译:backup');
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['primary', 'backup'] as const)('still accepts the %s result when the other racing service fails', async winner => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const primary = delayed('primary', 1700, winner !== 'primary');
        const backup = delayed('backup', 100, winner !== 'backup');
        const request = run([primary, backup], fastOptions);
        await vi.advanceTimersByTimeAsync(1700);
        await expect(request).resolves.toBe(`译:${winner}`);
    });

    it('continues through distinct services after both racing attempts fail', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const first = delayed('a', 1700, true), second = delayed('b', 100, true), third = candidate('c');
        const request = run([first, second, third], fastOptions);
        await vi.advanceTimersByTimeAsync(1700);
        await expect(request).resolves.toBe('译:c');
        for (const item of [first, second, third]) expect(item.translate).toHaveBeenCalledOnce();
    });

    it('does not hedge sequential mode, a single enabled service, or a short timeout', async () => {
        for (const variant of ['sequential', 'single', 'short'] as const) {
            const run = createFreeFallbackRunner(1, {random: () => 0});
            const first = delayed('a', 900), second = candidate('b');
            const request = run(variant === 'single' ? [first] : [first, second], {
                ...fastOptions, mode: variant === 'sequential' ? 'sequential' : 'balanced',
                timeoutMs: variant === 'short' ? 1000 : 5000,
            });
            await vi.advanceTimersByTimeAsync(900);
            await expect(request).resolves.toBe('译:a');
            expect(second.translate).not.toHaveBeenCalled();
        }
    });

    it('shares one extra concurrency slot across requests and refills a limited hedge budget', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const a = delayed('a', 3000), b = delayed('b', 3000);
        const aBackup = delayed('a-backup', 100), bBackup = candidate('b-backup');
        const first = run([a, aBackup], fastOptions);
        const second = run([b, bBackup], fastOptions);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(first).resolves.toBe('译:a-backup');
        await expect(second).resolves.toBe('译:b');
        expect(bBackup.translate).not.toHaveBeenCalled();
        // 两次成功仅补回 0.4，不能每个慢段落都追加外发。
        const thirdBackup = candidate('c-backup');
        const third = run([delayed('c', 3000), thirdBackup], fastOptions);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(third).resolves.toBe('译:c');
        expect(thirdBackup.translate).not.toHaveBeenCalled();
        await run([candidate('fast-1')], fastOptions);
        await run([candidate('fast-2')], fastOptions);
        const last = run([delayed('d', 3000), candidate('d-backup')], fastOptions);
        await vi.advanceTimersByTimeAsync(1500);
        await expect(last).resolves.toBe('译:d-backup');
    });

    it('rechecks backup availability after the delay and honors provider limits', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const busy = {...candidate('busy'), maxConcurrency: 0};
        const primary = delayed('primary', 1800);
        const request = run([primary, busy], fastOptions);
        await vi.advanceTimersByTimeAsync(1800);
        await expect(request).resolves.toBe('译:primary');
        expect(busy.translate).not.toHaveBeenCalled();
    });

    it('cancels both active attempts and releases the hedge slot and timers', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const controller = new AbortController();
        const a = candidate('a', vi.fn(() => new Promise(() => undefined)));
        const b = candidate('b', vi.fn(() => new Promise(() => undefined)));
        const request = run([a, b], {...fastOptions, signal: controller.signal});
        const rejected = expect(request).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(1500);
        controller.abort();
        await rejected;
        for (const item of [a, b]) expect(vi.mocked(item.translate).mock.calls[0][0].aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await expect(run([candidate('next')], fastOptions)).resolves.toBe('译:next');
    });

    it('caps even an extended caller deadline at twenty seconds with no repeat of the service pool', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const a = candidate('a', vi.fn(() => new Promise(() => undefined)));
        const b = candidate('b', vi.fn(() => new Promise(() => undefined)));
        const request = run([a, b], {...fastOptions, timeoutMs: 30_000, deadline: Date.now() + 60_000});
        const rejected = expect(request).rejects.toMatchObject({message: '请求超时', kind: 'timeout', retryable: false});
        await vi.advanceTimersByTimeAsync(20_000);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
        expect(a.translate).toHaveBeenCalledOnce();
        expect(b.translate).toHaveBeenCalledOnce();
    });

    it('returns promptly with hanging storage and a throwing observer', async () => {
        const run = createFreeFallbackRunner(1, {persistence: {load: async () => [], save: () => new Promise(() => undefined)}});
        const observer = vi.fn(() => { throw new Error('statistics unavailable'); });
        const request = run([candidate('a')], {...fastOptions, onAttempt: observer});
        await vi.advanceTimersByTimeAsync(0);
        await expect(request).resolves.toBe('译:a');
        expect(observer).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});


// 这些结果全部来自受控 deferred/mock；不代表任何 provider 的真实输出或原生 Wikipedia 归因。
describe('free pool availability waits keep global attempt capacity usable', () => {
    const ownerOptions = {mode: 'sequential' as const, timeoutMs: 5_000, cooldownMs: 1_000};
    const settleImmediateWork = () => vi.advanceTimersByTimeAsync(0);

    it('a capacity waiter cannot time out an independent owner with an idle route', async () => {
        const run = createFreeFallbackRunner(2, {random: () => 0});
        const gate = deferred();
        const limitedTranslate = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue('fixture:resumed');
        const limited = {...candidate('fixture-limited', limitedTranslate), maxConcurrency: 1};
        const active = run([limited], ownerOptions);
        await settleImmediateWork();
        const parked = run([limited], ownerOptions);
        await settleImmediateWork();
        expect(limitedTranslate).toHaveBeenCalledOnce();

        const idle = candidate('fixture-idle');
        const start = Date.now();
        const ready = run([idle], {...ownerOptions, deadline: start + 1_000});
        const readyOutcome = ready.then(value => ({value}), error => ({error}));
        await settleImmediateWork();
        // 基线在这里是 0 次调用：active + parked 占满 2 个全局许可，idle 被卡在 acquire。
        expect(idle.translate).toHaveBeenCalledOnce();
        await expect(readyOutcome).resolves.toEqual({value: '译:fixture-idle'});
        expect(Date.now()).toBe(start);
        expect(limitedTranslate).toHaveBeenCalledOnce();
        gate.resolve('fixture:active');
        await expect(active).resolves.toBe('fixture:active');
        await expect(parked).resolves.toBe('fixture:resumed');
        expect(limitedTranslate).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an interval waiter cannot occupy the last global permit while every HTTP attempt is idle', async () => {
        const run = createFreeFallbackRunner(1, {random: () => 0});
        const paced = {...candidate('fixture-paced'), maxConcurrency: 1, minIntervalMs: 2_000};
        await expect(run([paced], ownerOptions)).resolves.toBe('译:fixture-paced');
        const start = Date.now();
        const parked = run([paced], ownerOptions);
        await settleImmediateWork();
        expect(paced.translate).toHaveBeenCalledOnce();
        const idle = candidate('fixture-idle-interval');
        const ready = run([idle], {...ownerOptions, deadline: start + 1_000});
        const readyOutcome = ready.then(value => ({value}), error => ({error}));
        await settleImmediateWork();
        // 基线没有任何在途 HTTP，却让 paced 的 2 秒间隔挤掉另一个 owner 的 1 秒预算。
        expect(idle.translate).toHaveBeenCalledOnce();
        await expect(readyOutcome).resolves.toEqual({value: '译:fixture-idle-interval'});
        await vi.advanceTimersByTimeAsync(1_999);
        expect(paced.translate).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await expect(parked).resolves.toBe('译:fixture-paced');
        expect(paced.translate).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancelling a parked owner returns no second permit and never cancels the active owner', async () => {
        const run = createFreeFallbackRunner(2, {random: () => 0});
        const gate = deferred();
        let activeSignal!: AbortSignal;
        const limitedTranslate = vi.fn((signal: AbortSignal) => { activeSignal = signal; return gate.promise; });
        const limited = {...candidate('fixture-cancel-limited', limitedTranslate), maxConcurrency: 1};
        const active = run([limited], ownerOptions);
        await settleImmediateWork();
        const cancelledOwner = new AbortController();
        const parked = run([limited], {...ownerOptions, signal: cancelledOwner.signal});
        const parkedOutcome = parked.then(value => ({value}), error => ({error}));
        await settleImmediateWork();
        cancelledOwner.abort();
        await expect(parkedOutcome).resolves.toMatchObject({error: {name: 'AbortError'}});
        expect(activeSignal.aborted).toBe(false);

        const otherGate = deferred();
        const other = candidate('fixture-other-live', vi.fn(() => otherGate.promise));
        const secondActive = run([other], ownerOptions);
        await settleImmediateWork();
        expect(other.translate).toHaveBeenCalledOnce();
        const third = candidate('fixture-third');
        const queued = run([third], ownerOptions);
        await settleImmediateWork();
        // 若 parked 的 finally 重复归还，第三项会突破仍然有效的全局上限。
        expect(third.translate).not.toHaveBeenCalled();
        otherGate.resolve('fixture:other');
        await expect(secondActive).resolves.toBe('fixture:other');
        await expect(queued).resolves.toBe('译:fixture-third');
        expect(limitedTranslate).toHaveBeenCalledOnce();
        gate.resolve('fixture:active');
        await expect(active).resolves.toBe('fixture:active');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an expired parked owner keeps its original deadline and leaves active transport and health untouched', async () => {
        const run = createFreeFallbackRunner(2, {random: () => 0});
        const gate = deferred();
        let activeSignal!: AbortSignal;
        const limitedTranslate = vi.fn((signal: AbortSignal) => { activeSignal = signal; return gate.promise; });
        const limited = {...candidate('fixture-deadline-limited', limitedTranslate), maxConcurrency: 1};
        const active = run([limited], ownerOptions);
        await settleImmediateWork();
        const events: FreeFallbackAttempt[] = [];
        const start = Date.now();
        const parked = run([limited], {...ownerOptions, deadline: start + 1_000, onAttempt: event => events.push(event)});
        const parkedOutcome = parked.then(value => ({value}), error => ({error}));
        await vi.advanceTimersByTimeAsync(999);
        expect(events).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await expect(parkedOutcome).resolves.toMatchObject({error: {kind: 'timeout', retryable: false,
            code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryAfterMs: 1000}});
        expect(Date.now()).toBe(start + 1_000);
        expect(events).toEqual([]);
        expect(limitedTranslate).toHaveBeenCalledOnce();
        expect(activeSignal.aborted).toBe(false);
        expect(await run.getHealthSnapshot()).toEqual([]);
        await expect(run([candidate('fixture-after-timeout')], ownerOptions)).resolves.toBe('译:fixture-after-timeout');
        gate.resolve('fixture:active');
        await expect(active).resolves.toBe('fixture:active');
        expect(limitedTranslate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('awakened owners recheck the route cap after reacquiring instead of reusing a stale ready choice', async () => {
        const run = createFreeFallbackRunner(3, {random: () => 0});
        const gates = [deferred(), deferred(), deferred()];
        let calls = 0;
        let transports = 0;
        let maximum = 0;
        const limitedTranslate = vi.fn(() => {
            const gate = gates[calls++]!;
            transports += 1;
            maximum = Math.max(maximum, transports);
            return gate.promise.finally(() => { transports -= 1; });
        });
        const limited = {...candidate('fixture-recheck', limitedTranslate), maxConcurrency: 1};
        const first = run([limited], ownerOptions);
        await settleImmediateWork();
        const second = run([limited], ownerOptions);
        const third = run([limited], ownerOptions);
        await settleImmediateWork();
        expect(limitedTranslate).toHaveBeenCalledOnce();
        gates[0]!.resolve('fixture:first');
        await expect(first).resolves.toBe('fixture:first');
        await settleImmediateWork();
        expect(limitedTranslate).toHaveBeenCalledTimes(2);
        expect(maximum).toBe(1);
        gates[1]!.resolve('fixture:second');
        await settleImmediateWork();
        expect(limitedTranslate).toHaveBeenCalledTimes(3);
        expect(maximum).toBe(1);
        gates[2]!.resolve('fixture:third');
        await expect(Promise.all([second, third])).resolves.toEqual(['fixture:second', 'fixture:third']);
        expect(transports).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});
