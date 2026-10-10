import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createGoogleRequestGate, type GoogleHttpLease} from '@/src/providers/translation/googleRequestGate';

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0);});
afterEach(() => {expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.restoreAllMocks();});
const signal = () => new AbortController().signal;

describe('Google 真实 HTTP 共享队列', () => {
    it('许可交付后的新 429 使旧许可失效；未发 HTTP 的取消不会消耗启动间隔', async () => {
        const gate = createGoogleRequestGate();
        const unpublished = await gate.acquire(signal(), 5000);
        expect(unpublished.isCurrent()).toBe(true);
        unpublished.finish(false, false);
        const next = await gate.acquire(signal(), 5000);
        expect(Date.now()).toBe(0);
        gate.pause({retryAfterMs: 1000}); expect(next.isCurrent()).toBe(false);
        next.finish(false, false);
        await expect(gate.acquire(signal(), 500)).rejects.toMatchObject({statusCode: 429});
    });
    it('较早的未启动许可取消时保留后来许可的启动间隔', async () => {
        const gate = createGoogleRequestGate();
        const first = await gate.acquire(signal(), 5000);
        const two = gate.acquire(signal(), 5000);
        await vi.advanceTimersByTimeAsync(200); const second = await two;
        first.finish(false, false);
        let started = false;
        const three = gate.acquire(signal(), 5000).then(lease => {started = true; return lease;});
        await vi.advanceTimersByTimeAsync(199); expect(started).toBe(false);
        await vi.advanceTimersByTimeAsync(1); const third = await three;
        second.finish(false); third.finish(true);
    });
    it('FIFO 覆盖换线请求，启动相隔 200ms，真实传输未结束时最多两路在途', async () => {
        const gate = createGoogleRequestGate();
        const starts: number[] = [];
        const first = await gate.acquire(signal(), 10_000); starts.push(Date.now());
        let second!: GoogleHttpLease;
        let third!: GoogleHttpLease;
        const two = gate.acquire(signal(), 10_000).then(lease => {second = lease; starts.push(Date.now());});
        const three = gate.acquire(signal(), 10_000).then(lease => {third = lease; starts.push(Date.now());});
        await vi.advanceTimersByTimeAsync(199); expect(starts).toEqual([0]);
        await vi.advanceTimersByTimeAsync(201); expect(starts).toEqual([0, 200]);
        first.finish(false); await three;
        expect(starts).toEqual([0, 200, 400]);
        // 重复归还不得多释放容量；另两个实际传输仍占有许可。
        first.finish(true);
        await two; second.finish(true); third.finish(true);
    });

    it('等待者取消立即清理计时器/监听器，已取消调用不进入队列', async () => {
        const gate = createGoogleRequestGate();
        const first = await gate.acquire(signal(), 5000);
        const cancelled = new AbortController(); cancelled.abort();
        await expect(gate.acquire(cancelled.signal, 5000)).rejects.toMatchObject({name: 'AbortError'});
        const owner = new AbortController();
        const remove = vi.spyOn(owner.signal, 'removeEventListener');
        const pending = gate.acquire(owner.signal, 5000);
        const assertion = expect(pending).rejects.toThrow('owner left');
        owner.abort(new Error('owner left')); await assertion;
        expect(remove).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        first.finish(true);
    });

    it('独立等待预算不会被前面的长预算遮住，也不会被记录成端点故障', async () => {
        const gate = createGoogleRequestGate();
        const first = await gate.acquire(signal(), 5000);
        const two = gate.acquire(signal(), 5000);
        await vi.advanceTimersByTimeAsync(200); const second = await two;
        const owner = new AbortController();
        const long = gate.acquire(owner.signal, 5000);
        const longAssertion = expect(long).rejects.toMatchObject({name: 'AbortError'});
        const short = gate.acquire(signal(), 250);
        const shortAssertion = expect(short).rejects.toMatchObject({googleQueueError: true});
        await vi.advanceTimersByTimeAsync(50); await shortAssertion;
        owner.abort(); await longAssertion;
        first.finish(false); second.finish(false);
        await expect(gate.acquire(signal(), Date.now())).rejects.toMatchObject({googleQueueError: true});
    });

    it('服务端长等待装不进 caller 预算时立即返回剩余 Retry-After', async () => {
        const gate = createGoogleRequestGate();
        gate.pause({retryAfterMs: 60_000});
        await vi.advanceTimersByTimeAsync(1234);
        await expect(gate.acquire(signal(), 8000)).rejects.toMatchObject({statusCode: 429, retryAfterMs: 58_766, googleQueueError: true});
    });

    it('恢复前暂停所有入口，冷却到期仅一个探测；旧在途成功不能解除新 429', async () => {
        const gate = createGoogleRequestGate();
        const old = await gate.acquire(signal(), 10_000);
        gate.pause({retryAfterMs: 1000});
        const started: number[] = [];
        let probe!: GoogleHttpLease;
        let next!: GoogleHttpLease;
        const recovery = gate.acquire(signal(), 10_000).then(lease => {probe = lease; started.push(Date.now());});
        const waiting = gate.acquire(signal(), 10_000).then(lease => {next = lease; started.push(Date.now());});
        old.finish(true);
        await vi.advanceTimersByTimeAsync(999); expect(started).toEqual([]);
        await vi.advanceTimersByTimeAsync(401); await recovery; expect(started).toEqual([1000]);
        probe.finish(true); await waiting;
        expect(started).toEqual([1000, 1400]);
        next.finish(true);
        // 真正的恢复成功清除失败计数，下一次无 header 限流重新从 1s 开始。
        gate.pause({});
        await expect(gate.acquire(signal(), 1500)).rejects.toMatchObject({retryAfterMs: 1000});
    });

    it('恢复传输失败/取消释放 probe，但保留限制；探测期间后来的 429 仍以新版本为准', async () => {
        const gate = createGoogleRequestGate();
        gate.pause({retryAfterMs: 500});
        const one = gate.acquire(signal(), 10_000);
        await vi.advanceTimersByTimeAsync(500); const first = await one;
        const two = gate.acquire(signal(), 10_000);
        first.finish(false);
        await vi.advanceTimersByTimeAsync(200); const second = await two;
        gate.pause({retryAfterMs: 1500});
        second.finish(true);
        await expect(gate.acquire(signal(), 1000)).rejects.toMatchObject({retryAfterMs: 1500});
    });

    it.each([undefined, NaN, Infinity, 0, -1, '2'])('无有效服务端提示 %s 时指数退避有界，连续限流从 1/2/4 秒增长到最多 60 秒', async retryAfterMs => {
        const gate = createGoogleRequestGate();
        for (const duration of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
            gate.pause({retryAfterMs});
            await expect(gate.acquire(signal(), Date.now() + 1)).rejects.toMatchObject({statusCode: 429, retryAfterMs: duration});
            await vi.advanceTimersByTimeAsync(duration);
        }
    });

    it('同时收到不同 Retry-After 保留较长限制，不提前开始其他入口', async () => {
        const gate = createGoogleRequestGate();
        gate.pause({retryAfterMs: 5000}); gate.pause({retryAfterMs: 1000});
        await expect(gate.acquire(signal(), 1000)).rejects.toMatchObject({retryAfterMs: 5000});
    });
});
