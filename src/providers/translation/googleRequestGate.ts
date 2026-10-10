/**
 * @file src/providers/translation/googleRequestGate.ts
 * 文件职责：约束 Google 匿名翻译的真实 HTTP 启动，并在任一入口限流时暂停整个 Google 请求队列。
 * 主要内容：以 FIFO、两路在途和 200 毫秒启动间隔调度传输；保留服务端 Retry-After，缺省使用有界指数退避；冷却后只发一个恢复探测，通过版本隔离迟到成功，按调用方绝对截止时间和取消信号清理等待。
 * 模块边界：仅持有 Google 传输的规模与健康状态，不存储原文、不选择端点、不访问浏览器或网络；适配器在真实 HTTP 完成后归还许可。
 */
import {abortErrorFromSignal} from '@/src/platform/http/runtime';

export interface GoogleHttpLease {
    isCurrent(): boolean;
    finish(success: boolean, dispatched?: boolean): void;
}

/** 等待预算耗尽不是某个 Google 端点的传输故障。 */
export function googleRequestDeadlineError(): Error {
    return Object.assign(new Error('谷歌翻译总请求时间已耗尽'), {googleQueueError: true});
}
interface WaitingRequest {
    signal: AbortSignal;
    deadlineAt: number;
    resolve(lease: GoogleHttpLease): void;
    reject(error: Error): void;
    cleanup(): void;
}

/** 所有入口共用一份实例；上层预算不足时保留准确限流身份，供免费池切换其他供应商。 */
export function createGoogleRequestGate() {
    const pending: WaitingRequest[] = [];
    let active = 0;
    let nextStartAt = 0;
    let retryAt = 0;
    let failures = 0;
    let version = 0;
    let probing = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const rateLimitError = () => Object.assign(new Error('谷歌翻译请求过于频繁，请稍后重试（HTTP 429）'), {
        statusCode: 429,
        kind: 'rate-limit',
        retryable: false,
        googleQueueError: true,
        retryAfterMs: Math.max(1, retryAt - Date.now()),
    });

    function drain(): void {
        clearTimeout(timer);
        timer = undefined;
        const now = Date.now();
        // 任一等待者的预算都独立生效；短预算不能被前方较长的等待者遮住。
        for (let index = pending.length - 1; index >= 0; index--) {
            const entry = pending[index]!;
            if (entry.deadlineAt <= now || (retryAt > now && retryAt >= entry.deadlineAt)) {
                pending.splice(index, 1);
                entry.cleanup();
                entry.reject(failures > 0 ? rateLimitError() : googleRequestDeadlineError());
            }
        }
        while (pending.length && active < 2 && !probing && Math.max(nextStartAt, retryAt) <= now) {
            const entry = pending.shift()!;
            entry.cleanup();
            active += 1;
            nextStartAt = now + 200;
            const leaseSequence = ++sequence;
            const leaseVersion = version;
            const recovery = failures > 0;
            if (recovery) probing = true;
            let finished = false;
            entry.resolve({isCurrent: () => leaseVersion === version,
                finish(success, dispatched = true) {
                if (finished) return;
                finished = true;
                active -= 1;
                // 许可交付后的微任务若取消或出现新 429，并未启动的 HTTP 不消费启动间隔。
                if (!dispatched && leaseSequence === sequence) nextStartAt = now;
                if (recovery) probing = false;
                // 在较早传输发出后出现的 429，不能被它迟到的成功响应抹掉。
                if (success && leaseVersion === version) {
                    retryAt = 0;
                    failures = 0;
                }
                drain();
            }});
        }
        if (!pending.length) return;
        const deadline = Math.min(...pending.map(entry => entry.deadlineAt));
        const readyAt = active >= 2 || probing ? deadline : Math.min(deadline, Math.max(nextStartAt, retryAt));
        timer = setTimeout(drain, Math.max(1, readyAt - now));
    }

    return {
        acquire(signal: AbortSignal, deadlineAt: number): Promise<GoogleHttpLease> {
            if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    pending.splice(pending.indexOf(entry), 1);
                    entry.cleanup();
                    reject(abortErrorFromSignal(signal));
                    drain();
                };
                const entry: WaitingRequest = {signal, deadlineAt, resolve, reject,
                    cleanup: () => signal.removeEventListener('abort', onAbort)};
                signal.addEventListener('abort', onAbort, {once: true});
                pending.push(entry);
                drain();
            });
        },
        pause(error: object): void {
            const retryAfterMs = (error as {retryAfterMs?: unknown}).retryAfterMs;
            const delay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
                ? retryAfterMs : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
            failures += 1;
            version += 1;
            retryAt = Math.max(retryAt, Date.now() + delay);
            drain();
        },
    };
}
