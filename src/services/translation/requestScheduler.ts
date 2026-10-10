/**
 * @file src/services/translation/requestScheduler.ts
 *
 * 文件职责：统一执行翻译任务的并发和请求启动速率限制，支持取消、截止时间、服务/模型 bucket 与真实 HTTP attempt。
 * 主要内容：复用 global/服务/模型 bucket、FIFO、取消、deadline 和 lease；真实 HTTP 响应把 Retry-After 冷却写入可信 quota 摘要，冷却中的线路不阻塞其他线路，broker SDK 逻辑等待不占槽，真实 HTTP attempt 复用同一 bucket 的并发与速率。
 * 模块边界：本模块只管理调度时序，不选择服务、不实现重试、不读取或写入配置；配置由调用方通过 getConfig 提供。
 */

import {
    normalizeMaxConcurrentTranslations,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from '@/src/core/config/scheduling';
import {normalizeTranslationRequestLimits} from '@/src/core/config/requestLimits';

export interface TranslationRequestLimits {
    maxConcurrentTranslations?: unknown;
    translationRequestsPerSecond?: unknown;
    translationRequestsPerMinute?: unknown;
}

export interface TranslationRequestLimitSetting {
    enabled?: unknown;
    limits?: TranslationRequestLimits;
}

export interface TranslationRequestSchedulerConfig extends TranslationRequestLimits {
    serviceRequestLimits?: Record<string, TranslationRequestLimitSetting>;
    modelRequestLimits?: Record<string, Record<string, TranslationRequestLimitSetting>>;
}

export interface TranslationRequestIdentity {
    readonly service?: string;
    readonly model?: string;
    /** 后台由冻结端点、模型、凭据及普通/私密上下文计算；不接受 runtime payload。 */
    readonly quotaScope?: string;
}

export interface TranslationRequestLease {
    holdUntil(settlement: PromiseLike<unknown>): void;
}

export interface TranslationRequestSchedulerTaskOptions {
    signal?: AbortSignal;
    deadlineAt?: number;
    identity?: TranslationRequestIdentity;
    /** 外层调用的速率开关；broker SDK 由真实 scheduleAttempt 计速率。 */
    countRate?: boolean;
    /** SDK 逻辑等待不占槽；缺省保持旧并发语义。 */
    countConcurrency?: boolean;
}

export interface TranslationRequestAttemptOptions {
    /** broker SDK 的真实传输持槽；直调缺省沿用已持有外层槽的旧语义。 */
    countConcurrency?: boolean;
    signal?: AbortSignal;
    deadlineAt?: number;
    identity?: TranslationRequestIdentity;
}

export interface TranslationRequestScheduler {
    schedule<T>(task: (lease: TranslationRequestLease) => Promise<T>, options?: TranslationRequestSchedulerTaskOptions): Promise<T>;
    /** 真实 HTTP attempt 可取得并发和速率；缺省仍复用直调的外层并发 lease。 */
    scheduleAttempt<T>(task: () => Promise<T>, options?: TranslationRequestAttemptOptions): Promise<T>;
    /** transport 收到响应后、归还 attempt 前反馈；不增加重试或修改供应商响应。 */
    observeResponse(identity: TranslationRequestIdentity | undefined, response: Pick<Response, 'status' | 'headers'>): void;
}

export class TranslationRequestSchedulerDeadlineError extends Error {
    readonly code = 'TRANSLATION_SCHEDULER_DEADLINE_EXCEEDED';
    constructor(message = '翻译请求超时') {
        super(message);
        this.name = 'TranslationRequestSchedulerDeadlineError';
    }
}

interface BucketLimit {
    concurrency: number;
    perSecond: number;
    perMinute: number;
}
interface BucketState {
    active: number;
    starts: number[];
}
interface PendingRequest<T> {
    readonly task: (lease: TranslationRequestLease) => Promise<T>;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
    readonly identity?: TranslationRequestIdentity;
    readonly attemptOnly: boolean;
    readonly countRate: boolean;
    readonly countConcurrency: boolean;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
    settled: boolean;
    removeAbortListener?: () => void;
}

export interface TranslationRequestSchedulerDependencies {
    now?: () => number;
}

function createAbortError(): Error {
    const error = new Error('翻译已取消');
    error.name = 'AbortError';
    return error;
}
function finiteNow(now: () => number): number {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
}
function clean(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function retryAfterMs(headers: Headers, current: number): number | undefined {
    const milliseconds = headers.get('retry-after-ms')?.trim();
    const ms = milliseconds && /^\d+(?:\.\d+)?$/u.test(milliseconds) ? Number(milliseconds) : NaN;
    if (Number.isFinite(ms)) return Math.min(ms, 7 * 86_400_000);
    const value = headers.get('retry-after')?.trim();
    if (!value) return undefined;
    // 不把带符号、指数、尾随垃圾或单个无效数字误当成日期。
    const numeric = /^\d+(?:\.\d+)?$/u.test(value);
    const duration = numeric ? Number(value) * 1000
        : /[A-Za-z]{3}/u.test(value) ? Date.parse(value) - current : NaN;
    return Number.isFinite(duration) && duration >= 0 ? Math.min(duration, 7 * 86_400_000) : undefined;
}

export function createTranslationRequestScheduler(
    getConfig: () => TranslationRequestSchedulerConfig,
    dependencies: TranslationRequestSchedulerDependencies = {},
): TranslationRequestScheduler {
    const now = dependencies.now ?? (() => Date.now());
    const buckets = new Map<string, BucketState>();
    const cooldowns = new Map<string, number>();
    let pending: Array<PendingRequest<unknown> | undefined> = [];
    let head = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let drainRequested = false;
    let lastNow: number | undefined;

    function readNow(): number {
        const current = finiteNow(now);
        if (lastNow !== undefined && current < lastNow) {
            for (const state of buckets.values()) state.starts.length = 0;
            cooldowns.clear();
        }
        for (const [scope, until] of cooldowns) if (until <= current) cooldowns.delete(scope);
        lastNow = current;
        return current;
    }

    function currentConfig(): TranslationRequestSchedulerConfig {
        try {
            return getConfig() || {};
        } catch {
            return {};
        }
    }

    const GLOBAL_KEYS: readonly string[] = ['global'];
    /**
     * 一次 drain 内配置是固定的，而 bucket key 与限额原本要为每个待处理任务
     * （并在公平性检查里为每个更早的任务）重新做 JSON.stringify / JSON.parse。
     * 这两张表把同一次 drain 内的重复计算折叠成一次。
     */
    let keyMemo = new Map<string, readonly string[]>();
    let limitMemo = new Map<string, BucketLimit>();

    function resetDrainMemo(): void {
        keyMemo = new Map();
        limitMemo = new Map();
    }

    function keysFor(identity: TranslationRequestIdentity | undefined, config: TranslationRequestSchedulerConfig): readonly string[] {
        const service = clean(identity?.service);
        if (!service) return GLOBAL_KEYS;
        const model = clean(identity?.model);
        const memoKey = `${service}\u0000${model}`;
        const cached = keyMemo.get(memoKey);
        if (cached) return cached;
        const serviceSetting = config.serviceRequestLimits?.[service];
        const modelSetting = model ? config.modelRequestLimits?.[service]?.[model] : undefined;
        let result: readonly string[];
        if (modelSetting?.enabled === true) {
            const keys = [JSON.stringify(['model', service, model])];
            if (serviceSetting?.enabled === true) keys.push(JSON.stringify(['service', service]));
            result = keys;
        } else {
            result = serviceSetting?.enabled === true ? [JSON.stringify(['service', service])] : GLOBAL_KEYS;
        }
        keyMemo.set(memoKey, result);
        return result;
    }

    function stateFor(key: string): BucketState {
        let state = buckets.get(key);
        if (!state) {
            state = {active: 0, starts: []};
            buckets.set(key, state);
        }
        return state;
    }

    function limitFor(key: string, config: TranslationRequestSchedulerConfig): BucketLimit {
        const cached = limitMemo.get(key);
        if (cached) return cached;
        let limit: BucketLimit;
        if (key === 'global') {
            limit = {
                concurrency: normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations),
                perSecond: normalizeTranslationRequestsPerSecond(config.translationRequestsPerSecond),
                perMinute: normalizeTranslationRequestsPerMinute(config.translationRequestsPerMinute),
            };
        } else {
            const [kind, service, model] = JSON.parse(key) as string[];
            const setting = kind === 'service' ? config.serviceRequestLimits?.[service!] : config.modelRequestLimits?.[service!]?.[model!];
            const limits = normalizeTranslationRequestLimits(setting?.limits);
            limit = {
                concurrency: limits.maxConcurrentTranslations,
                perSecond: limits.translationRequestsPerSecond,
                perMinute: limits.translationRequestsPerMinute,
            };
        }
        limitMemo.set(key, limit);
        return limit;
    }

    function prune(state: BucketState, current: number): void {
        const cutoff = current - 60_000;
        let index = 0;
        while (index < state.starts.length && state.starts[index]! <= cutoff) index += 1;
        if (index) state.starts.splice(0, index);
    }

    function waitFor(key: string, current: number, config: TranslationRequestSchedulerConfig, concurrency: boolean, countRate: boolean): number {
        const state = stateFor(key);
        const limits = limitFor(key, config);
        prune(state, current);
        if (concurrency && state.active >= limits.concurrency) return Number.POSITIVE_INFINITY;
        if (!countRate) return 0;
        let wait = 0;
        if (limits.perSecond > 0 && state.starts.length >= limits.perSecond) {
            // 启动时间单调递增：只需检查倒数第 N 条何时离开窗口，不必逐条数最近一秒的记录。
            // 配置动态降低上限时也使用同一位置，恰好满一秒的记录不再占用速率额度。
            wait = Math.max(wait, state.starts[state.starts.length - limits.perSecond]! + 1_000 - current);
        }
        if (limits.perMinute > 0 && state.starts.length >= limits.perMinute) {
            wait = Math.max(wait, state.starts[state.starts.length - limits.perMinute]! + 60_000 - current);
        }
        return wait;
    }

    function compact(): void {
        while (head < pending.length && !pending[head]) head += 1;
        if (head >= pending.length) {
            pending = [];
            head = 0;
        } else if (head >= 1024 && head * 2 >= pending.length) {
            pending = pending.slice(head);
            head = 0;
        }
    }

    function rejectPending(entry: PendingRequest<unknown>, error: unknown): void {
        entry.settled = true;
        entry.removeAbortListener?.();
        entry.reject(error);
    }

    function rejectInactive(current: number): void {
        for (let index = head; index < pending.length; index += 1) {
            const entry = pending[index];
            if (!entry) continue;
            if (entry.settled) pending[index] = undefined;
            else if (entry.deadlineAt !== undefined && entry.deadlineAt <= current) {
                pending[index] = undefined;
                rejectPending(entry, new TranslationRequestSchedulerDeadlineError());
            }
        }
        compact();
    }

    function arm(delay: number): void {
        timer = setTimeout(() => {
            timer = undefined;
            drain();
        }, Math.max(1, Math.ceil(delay)));
    }

    function createLease() {
        const waits: Promise<void>[] = [];
        let open = true;
        return {
            lease: {
                holdUntil: (settlement: PromiseLike<unknown>) => {
                    if (!open) throw new Error('翻译请求已结束，无法继续占用调度槽');
                    waits.push(Promise.resolve(settlement).then(() => undefined, () => undefined));
                },
            },
            waits,
            close: () => { open = false; },
        };
    }

    async function execute(entry: PendingRequest<unknown>, keys: readonly string[]): Promise<void> {
        const leaseState = createLease();
        try {
            const result = await entry.task(leaseState.lease);
            if (!entry.settled) {
                entry.settled = true;
                entry.removeAbortListener?.();
                entry.resolve(result);
            }
        } catch (error) {
            if (!entry.settled) {
                entry.settled = true;
                entry.removeAbortListener?.();
                entry.reject(error);
            }
        } finally {
            // 调用方可以先收到取消/超时；真实传输结束后才归还并发槽。
            leaseState.close();
            await Promise.all(leaseState.waits);
            if (entry.countConcurrency) {
                for (const key of keys) stateFor(key).active -= 1;
            }
            drain();
        }
    }

    function drain(): void {
        if (draining) {
            drainRequested = true;
            return;
        }
        draining = true;
        try {
            // task 可以同步取消较早的等待请求；重入只标记重扫，外层迭代接续，
            // 不递归增长调用栈，也不等无关的活动请求结束后才释放公平性阻塞。
            do {
                drainRequested = false;
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                const config = currentConfig();
                resetDrainMemo();
                const current = readNow();
                rejectInactive(current);
                let earliest = Number.POSITIVE_INFINITY;
                // 启动一个任务只会让 bucket 更满，不可能解锁更早被阻塞的任务，因此
                // 单次前向扫描即可启动本轮全部可启动任务。公平性要求同 bucket 中更早
                // 仍在等待的任务先行：扫描时累积这些 bucket key，每项判定只看自身 1~2 个 key，
                // 避免对每个等待项回扫全部更早项造成 O(待处理数²)。
                const waitingKeys = new Set<string>();
                // 旧直调的 HTTP 重试复用外层槽；持槽的真实 attempt 进入同一 FIFO。
                const waitingAttemptKeys = new Set<string>();
                const keepWaiting = (entry: PendingRequest<unknown>, keys: readonly string[]) => {
                    for (const key of keys) {
                        waitingKeys.add(key);
                        if (entry.attemptOnly && !entry.countConcurrency) waitingAttemptKeys.add(key);
                    }
                };
                for (let index = head; index < pending.length; index += 1) {
                    const entry = pending[index];
                    if (!entry || entry.settled) continue;
                    const cooldownWait = (cooldowns.get(clean(entry.identity?.quotaScope)) ?? current) - current;
                    if (cooldownWait > 0) {
                        earliest = Math.min(earliest, cooldownWait);
                        // 冷却不是 global bucket 的 FIFO 阻塞；健康线路仍按既有 bucket 顺序入场。
                        continue;
                    }
                    const keys = keysFor(entry.identity, config);
                    const blocking = entry.attemptOnly && !entry.countConcurrency ? waitingAttemptKeys : waitingKeys;
                    if ((entry.countConcurrency || entry.countRate) && keys.some((key) => blocking.has(key))) {
                        keepWaiting(entry, keys);
                        continue;
                    }
                    let wait = 0;
                    for (const key of keys) {
                        wait = Math.max(wait, waitFor(key, current, config, entry.countConcurrency, entry.countRate));
                    }
                    if (wait > 0) {
                        if (wait < earliest) earliest = wait;
                        keepWaiting(entry, keys);
                        continue;
                    }
                    pending[index] = undefined;
                    for (const key of keys) {
                        const state = stateFor(key);
                        if (entry.countConcurrency) state.active += 1;
                        if (entry.countRate) state.starts.push(current);
                    }
                    void execute(entry, keys);
                }
                compact();
                let nextDeadline = Number.POSITIVE_INFINITY;
                for (let index = head; index < pending.length; index += 1) {
                    const deadlineAt = pending[index]?.deadlineAt;
                    if (deadlineAt !== undefined && deadlineAt < nextDeadline) nextDeadline = deadlineAt;
                }
                // readNow 保证 current 有限，无 deadline 时 Infinity - current 仍为 Infinity。
                let wake = Math.min(earliest, Math.max(0, nextDeadline - current));
                for (const until of cooldowns.values()) wake = Math.min(wake, until - current);
                if (wake < Number.POSITIVE_INFINITY) arm(wake);
            } while (drainRequested);
        } finally {
            draining = false;
        }
    }

    function enqueue<T>(
        task: (lease: TranslationRequestLease) => Promise<T>,
        options: TranslationRequestSchedulerTaskOptions = {},
        attemptOnly = false,
    ): Promise<T> {
        if (options.signal?.aborted) return Promise.reject(createAbortError());
        return new Promise<T>((resolve, reject) => {
            const entry: PendingRequest<T> = {
                ...options, task, attemptOnly,
                countConcurrency: attemptOnly ? options.countConcurrency === true : options.countConcurrency !== false,
                countRate: attemptOnly || options.countRate !== false,
                resolve, reject, settled: false,
            };
            if (entry.signal) {
                const onAbort = () => {
                    entry.settled = true;
                    entry.reject(createAbortError());
                    drain();
                };
                entry.signal.addEventListener('abort', onAbort, {once: true});
                entry.removeAbortListener = () => entry.signal?.removeEventListener('abort', onAbort);
            }
            pending.push(entry as PendingRequest<unknown>);
            drain();
        });
    }

    return {
        observeResponse: (identity, response) => {
            const scope = clean(identity?.quotaScope);
            if (!scope || (response.status !== 429 && response.status !== 503)) return;
            const current = readNow();
            const retryAfter = retryAfterMs(response.headers, current);
            // 真实 429 的无效/缺省头沿用 SDK 的首个 2 秒退避；503 只有有效服务端头才共享冷却。
            const delay = retryAfter ?? (response.status === 429 ? 2000 : 0);
            if (delay <= 0) return;
            cooldowns.set(scope, Math.max(cooldowns.get(scope) ?? 0, current + delay));
            drain();
        },
        schedule: enqueue,
        scheduleAttempt: <T>(task: () => Promise<T>, options?: TranslationRequestAttemptOptions) => enqueue(task, options, true),
    };
}
