import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createFreeFallbackRunner, type FreeFallbackAttempt, type FreeFallbackCandidate} from '@/src/services/translation/freeFallback';

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
