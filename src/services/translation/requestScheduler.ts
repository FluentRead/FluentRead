/**
 * @file src/services/translation/requestScheduler.ts
 *
 * 文件职责：统一执行翻译任务的并发和请求启动速率限制，支持取消、截止时间、服务/模型 bucket 与真实 HTTP attempt；复用未解锁等待前沿，避免同批入队与取消反复扫描整队。
 * 主要内容：保留 global/服务/模型动态 bucket、FIFO、取消、deadline 与真实 transport lease；同一可信额度范围共享冷却，恢复时先放行一个真实请求，持续限流则延长退避。
 * 模块边界：本模块只管理调度时序，不选择服务、不实现重试、不读取或写入配置；配置由调用方通过 getConfig 提供。
 */

import {
    normalizeMaxConcurrentTranslations,
    normalizeTranslationRequestsPerMinute,
    normalizeTranslationRequestsPerSecond,
} from '@/src/core/config/scheduling';
import {normalizeTranslationRequestLimits} from '@/src/core/config/requestLimits';
import {readRetryAfterMs} from '@/src/platform/http/errors';

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
    scheduleAttempt<T>(task: (lease: TranslationRequestLease) => Promise<T>, options?: TranslationRequestAttemptOptions): Promise<T>;
    /** 收到响应后反馈；服务等待超出本次预算时返回可直接展示的诊断。 */
    observeResponse(identity: TranslationRequestIdentity | undefined, response: Pick<Response, 'status' | 'headers'>,
        lease?: TranslationRequestLease, deadlineAt?: number): TranslationRequestCooldownError | undefined | void;
}

export class TranslationRequestSchedulerDeadlineError extends Error {
    readonly code = 'TRANSLATION_SCHEDULER_DEADLINE_EXCEEDED';
    constructor(message = '翻译请求超时') {
        super(message);
        this.name = 'TranslationRequestSchedulerDeadlineError';
    }
}

export class TranslationRequestCooldownError extends Error {
    readonly kind: 'rate-limit' | 'provider';
    readonly retryable = false;

    constructor(readonly statusCode: number, readonly retryAfterMs: number) {
        super(statusCode === 429 ? '当前翻译服务的请求频率或配额已达上限（HTTP 429），请稍后重试。'
            : `当前翻译服务暂时不可用（HTTP ${statusCode}），请稍后重试。`);
        this.name = 'TranslationRequestCooldownError';
        this.kind = statusCode === 429 ? 'rate-limit' : 'provider';
    }
}

interface Cooldown {
    until: number;
    failures: number;
    status: number;
    probe?: PendingRequest<unknown>;
}

const COOLDOWN_RECOVERY_WINDOW_MS = 60_000;

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
    /** 仅等待项拥有槽位，便于取消时直接摘除；压缩时统一更新。 */
    slot?: number;
    waitingKeys?: readonly string[];
    wakeAt?: number;
    removeAbortListener?: () => void;
    lease?: TranslationRequestLease;
    recoveryFailed?: boolean;
}

export interface TranslationRequestSchedulerDependencies {
    now?: () => number;
    random?: () => number;
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

export function createTranslationRequestScheduler(
    getConfig: () => TranslationRequestSchedulerConfig,
    dependencies: TranslationRequestSchedulerDependencies = {},
): TranslationRequestScheduler {
    const now = dependencies.now ?? (() => Date.now());
    const random = dependencies.random ?? Math.random;
    const buckets = new Map<string, BucketState>();
    const cooldowns = new Map<string, Cooldown>();
    const activeRequests = new Set<PendingRequest<unknown>>();
    let pending: Array<PendingRequest<unknown> | undefined> = [];
    let head = 0;
    let pendingCount = 0;
    /** 资源未释放、配置未变且未到下次唤醒时，旧等待项不可能自行变为可执行。 */
    let frontier: {signature: string; at: number; wakeAt: number; fairnessReadyAt: number;
        waitingKeys: Map<string, number>; waitingAttemptKeys: Map<string, number>;
        readyBehindEarlier: Set<PendingRequest<unknown>>} | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draining = false;
    let drainRequested = false;
    let lastNow: number | undefined;

    function readNow(): number {
        const current = finiteNow(now);
        if (lastNow !== undefined && current < lastNow) {
            // observeResponse 也会读取时钟而不一定 drain；回退须直接撤销旧前沿。
            frontier = undefined;
            for (const state of buckets.values()) state.starts.length = 0;
            cooldowns.clear();
        }
        for (const [scope, cooldown] of cooldowns) {
            if (!cooldown.probe && cooldown.until + COOLDOWN_RECOVERY_WINDOW_MS <= current) cooldowns.delete(scope);
        }
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

    /** 只比较调度字段，避免序列化整份应用配置；原位修改和新对象都能正确失效。 */
    function configSignature(config: TranslationRequestSchedulerConfig): string {
        const limits = (value: TranslationRequestLimits | undefined) => [
            normalizeMaxConcurrentTranslations(value?.maxConcurrentTranslations),
            normalizeTranslationRequestsPerSecond(value?.translationRequestsPerSecond),
            normalizeTranslationRequestsPerMinute(value?.translationRequestsPerMinute),
        ];
        return JSON.stringify([
            limits(config),
            Object.entries(config.serviceRequestLimits ?? {}).flatMap(([service, setting]) =>
                setting?.enabled === true ? [[service, limits(setting.limits)]] : []),
            Object.entries(config.modelRequestLimits ?? {}).flatMap(([service, models]) =>
                Object.entries(models ?? {}).flatMap(([model, setting]) =>
                    setting?.enabled === true ? [[service, model, limits(setting.limits)]] : [])),
        ]);
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

    function refreshActiveBuckets(config: TranslationRequestSchedulerConfig, current: number): void {
        // 用户可在请求仍运行时切换沿用/自定义。启动时的 bucket 已不是当前约束，
        // 因此按稳定请求身份重新投影所有在途任务；starts 继续保留窗口内速率历史。
        // settled 仅表示调用方收到结果，holdUntil 未结束的 transport 仍在集合里。
        // 失效的模型配置不会再访问对应 bucket；在完整扫描时清理其过期历史，
        // 避免后台生命周期内模型不断切换导致状态和每次扫描成本持续增长。
        const emptyKeys: string[] = [];
        for (const [key, state] of buckets) {
            state.active = 0;
            prune(state, current);
            if (state.starts.length === 0) emptyKeys.push(key);
        }
        for (const entry of activeRequests) {
            for (const key of keysFor(entry.identity, config)) stateFor(key).active += 1;
        }
        for (const key of emptyKeys) {
            if (buckets.get(key)?.active === 0) buckets.delete(key);
        }
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

    function detach(entry: PendingRequest<unknown>): void {
        if (entry.slot === undefined) return;
        pending[entry.slot] = undefined;
        entry.slot = undefined;
        pendingCount -= 1;
    }

    function compact(): void {
        while (head < pending.length && !pending[head]) head += 1;
        if (head >= pending.length) {
            pending = [];
            head = 0;
        } else if (head >= 1024 && head * 2 >= pending.length) {
            pending = pending.slice(head);
            head = 0;
            pending.forEach((entry, index) => { if (entry) entry.slot = index; });
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
            // 取消和执行均先摘除等待槽；仍在 pending 的条目只需检查期限。
            if (entry.deadlineAt !== undefined && entry.deadlineAt <= current) {
                detach(entry);
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

    async function execute(entry: PendingRequest<unknown>, scope: string): Promise<void> {
        const leaseState = createLease();
        if (scope) entry.lease = leaseState.lease;
        let completed = false;
        try {
            const result = await entry.task(leaseState.lease);
            completed = true;
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
            activeRequests.delete(entry);
            // 只有恢复请求能解除自己的冷却。旧请求迟到或收到新一轮限流时，状态归属不同。
            const cooldown = cooldowns.get(scope);
            if (cooldown?.probe === entry) {
                if (completed && !entry.recoveryFailed && !entry.signal?.aborted) cooldowns.delete(scope);
                else cooldown.probe = undefined;
            }
            entry.lease = undefined;
            drain();
        }
    }

    function drain(trigger: 'full' | 'append' | 'cancel' = 'full', cancelledWakeAt?: number): void {
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
                const config = currentConfig();
                const signature = configSignature(config);
                const current = readNow();
                const previous = frontier;
                // 注入的配置/时钟读取也可同步入队或取消；这类重入必须重扫全部等待项。
                const reusable = !drainRequested && trigger !== 'full' && previous?.signature === signature
                    && current >= previous.at && current < previous.wakeAt && current < previous.fairnessReadyAt
                    ? previous : undefined;
                // 取消不会释放真实 transport 槽位。没有被 FIFO 单独挡住的就绪项时，
                // 且没有被 FIFO 隐藏的未来速率唤醒时，只摘除该条目即可；否则立即重扫，
                // 解锁其它模型/服务，或为解除 FIFO 后仍需等待的速率重新设置 timer。
                if (trigger === 'cancel' && reusable && reusable.readyBehindEarlier.size === 0
                    && !Number.isFinite(reusable.fairnessReadyAt)
                    && (!Number.isFinite(cancelledWakeAt) || cancelledWakeAt !== reusable.wakeAt)) {
                    compact();
                    if (pendingCount === 0) {
                        // 最后一个有限唤醒项的取消必走完整扫描；此处不可能残留 timer。
                        timer = undefined;
                        frontier = undefined;
                    }
                    return;
                }
                const incremental = trigger === 'append' ? reusable : undefined;
                const start = incremental ? pending.length - 1 : head;
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (!incremental) {
                    resetDrainMemo();
                    refreshActiveBuckets(config, current);
                    rejectInactive(current);
                }
                let earliest = incremental ? incremental.wakeAt - current : Number.POSITIVE_INFINITY;
                // 启动一个任务只会让 bucket 更满，不可能解锁更早被阻塞的任务，因此
                // 单次前向扫描即可启动本轮全部可启动任务。公平性要求同 bucket 中更早
                // 仍在等待的任务先行：扫描时累积这些 bucket key，每项判定只看自身 1~2 个 key，
                // 避免对每个等待项回扫全部更早项造成 O(待处理数²)。
                const waitingKeys = incremental ? incremental.waitingKeys : new Map<string, number>();
                // 旧直调重试复用外层槽；真正独立计并发的 attempt 进入普通 FIFO。
                const waitingAttemptKeys = incremental ? incremental.waitingAttemptKeys : new Map<string, number>();
                const readyBehindEarlier = incremental ? incremental.readyBehindEarlier : new Set<PendingRequest<unknown>>();
                let fairnessReadyAt = incremental ? incremental.fairnessReadyAt : Number.POSITIVE_INFINITY;
                const keepWaiting = (entry: PendingRequest<unknown>, keys: readonly string[]) => {
                    entry.waitingKeys = keys;
                    for (const key of keys) {
                        waitingKeys.set(key, (waitingKeys.get(key) ?? 0) + 1);
                        if (entry.attemptOnly && !entry.countConcurrency) {
                            waitingAttemptKeys.set(key, (waitingAttemptKeys.get(key) ?? 0) + 1);
                        }
                    }
                };
                for (let index = incremental ? start : head; index < pending.length; index += 1) {
                    const entry = pending[index];
                    if (!entry || entry.settled) continue;
                    entry.waitingKeys = undefined;
                    entry.wakeAt = entry.deadlineAt;
                    if (entry.deadlineAt !== undefined && entry.deadlineAt <= current) {
                        detach(entry);
                        rejectPending(entry, new TranslationRequestSchedulerDeadlineError());
                        continue;
                    }
                    const scope = clean(entry.identity?.quotaScope);
                    const cooldown = cooldowns.get(scope);
                    if (cooldown) {
                        const remaining = cooldown.until - current;
                        if (remaining > 0 && entry.deadlineAt !== undefined && cooldown.until >= entry.deadlineAt) {
                            detach(entry);
                            rejectPending(entry, new TranslationRequestCooldownError(cooldown.status, remaining));
                            continue;
                        }
                        if (remaining > 0 || cooldown.probe) {
                            if (remaining > 0) {
                                earliest = Math.min(earliest, remaining);
                                entry.wakeAt = Math.min(entry.wakeAt ?? Infinity, cooldown.until);
                            }
                            // 暂停的线路不参与 FIFO 阻塞，健康线路可继续请求。
                            continue;
                        }
                    }
                    const keys = keysFor(entry.identity, config);
                    const blocking = entry.attemptOnly && !entry.countConcurrency ? waitingAttemptKeys : waitingKeys;
                    const blockedByEarlier = (entry.countConcurrency || entry.countRate)
                        && keys.some((key) => blocking.has(key));
                    let wait = 0;
                    for (const key of keys) {
                        wait = Math.max(wait, waitFor(key, current, config, entry.countConcurrency, entry.countRate));
                    }
                    if (wait > 0 || blockedByEarlier) {
                        // FIFO 挡住的条目沿用更早条目的唤醒，不引入额外的提前 timer。
                        if (!blockedByEarlier && wait > 0) {
                            if (wait < earliest) earliest = wait;
                            entry.wakeAt = Math.min(entry.wakeAt ?? Number.POSITIVE_INFINITY, current + wait);
                        }
                        if (blockedByEarlier) {
                            if (wait <= 0) readyBehindEarlier.add(entry);
                            // 不额外排 timer，但速率自行恢复后取消/入队必须重新复核 FIFO。
                            else fairnessReadyAt = Math.min(fairnessReadyAt, current + wait);
                        }
                        keepWaiting(entry, keys);
                        continue;
                    }
                    detach(entry);
                    if (cooldown && entry.countRate) cooldown.probe = entry;
                    if (entry.countConcurrency) activeRequests.add(entry);
                    for (const key of keys) {
                        const state = stateFor(key);
                        if (entry.countConcurrency) state.active += 1;
                        if (entry.countRate) state.starts.push(current);
                    }
                    void execute(entry, scope);
                }
                let nextDeadline = Number.POSITIVE_INFINITY;
                for (let index = incremental ? start : head; index < pending.length; index += 1) {
                    const deadlineAt = pending[index]?.deadlineAt;
                    if (deadlineAt !== undefined && deadlineAt < nextDeadline) nextDeadline = deadlineAt;
                }
                const deadlineWait = nextDeadline === Number.POSITIVE_INFINITY
                    ? Number.POSITIVE_INFINITY
                    : Math.max(0, nextDeadline - current);
                const nextWait = Math.min(earliest, deadlineWait);
                compact();
                frontier = {signature, at: current, wakeAt: current + nextWait, fairnessReadyAt,
                    waitingKeys, waitingAttemptKeys, readyBehindEarlier};
                if (nextWait < Number.POSITIVE_INFINITY) arm(nextWait);
                // 任务同步入队/取消只标记重扫；后续轮必须重建完整前沿。
                trigger = 'full';
            } while (drainRequested);
        } finally {
            draining = false;
        }
    }

    function enqueue<T>(entry: PendingRequest<T>): Promise<T> {
        if (entry.signal?.aborted) return Promise.reject(createAbortError());
        return new Promise<T>((resolve, reject) => {
            (entry as {resolve: typeof resolve; reject: typeof reject}).resolve = resolve;
            (entry as {resolve: typeof resolve; reject: typeof reject}).reject = reject;
            if (entry.signal) {
                const onAbort = () => {
                    entry.settled = true;
                    const cancelledWakeAt = entry.slot === undefined ? undefined : entry.wakeAt;
                    if (entry.slot !== undefined && frontier && entry.waitingKeys) {
                        const remove = (counts: Map<string, number>, key: string): void => {
                            const count = counts.get(key) ?? 0;
                            if (count <= 1) counts.delete(key);
                            else counts.set(key, count - 1);
                        };
                        for (const key of entry.waitingKeys) {
                            remove(frontier.waitingKeys, key);
                            if (entry.attemptOnly && !entry.countConcurrency) remove(frontier.waitingAttemptKeys, key);
                        }
                    }
                    entry.waitingKeys = undefined;
                    detach(entry as PendingRequest<unknown>);
                    frontier?.readyBehindEarlier.delete(entry as PendingRequest<unknown>);
                    entry.reject(createAbortError());
                    drain('cancel', cancelledWakeAt);
                };
                entry.signal.addEventListener('abort', onAbort, {once: true});
                entry.removeAbortListener = () => entry.signal?.removeEventListener('abort', onAbort);
            }
            entry.slot = pending.length;
            pending.push(entry as PendingRequest<unknown>);
            pendingCount += 1;
            drain('append');
        });
    }

    return {
        observeResponse: (identity, response, lease, deadlineAt) => {
            const scope = clean(identity?.quotaScope);
            if (!scope) return;
            const probe = lease && cooldowns.get(scope)?.probe;
            const recovering = probe?.lease === lease && probe !== undefined;
            if (recovering && response.status >= 500) probe.recoveryFailed = true;
            if (response.status !== 429 && response.status !== 503) return;
            const current = readNow();
            const previous = cooldowns.get(scope);
            const failures = (previous?.failures ?? 0) + (!previous || recovering ? 1 : 0);
            const retryAfter = readRetryAfterMs(response.headers, current);
            // 首次限流等待 2 秒；只有恢复请求再次被限流才提高级别，给重复退避加入抖动。
            const delay = retryAfter ?? (response.status === 429
                ? Math.min(60_000, 2000 * 2 ** Math.min(5, failures - 1) * (failures > 1 ? 1 + random() / 4 : 1))
                : 0);
            if (delay <= 0) return;
            const until = Math.max(previous?.until ?? -Infinity, current + delay);
            cooldowns.set(scope, {until, failures, status: response.status});
            drain();
            if (deadlineAt !== undefined && until >= deadlineAt) {
                return new TranslationRequestCooldownError(response.status, until - current);
            }
        },
        schedule: <T>(task: (lease: TranslationRequestLease) => Promise<T>, options: TranslationRequestSchedulerTaskOptions = {}) => enqueue({
            task,
            signal: options.signal,
            deadlineAt: options.deadlineAt,
            identity: options.identity,
            attemptOnly: false,
            countConcurrency: options.countConcurrency !== false,
            countRate: options.countRate !== false,
            resolve: undefined as never,
            reject: undefined as never,
            settled: false,
        }),
        scheduleAttempt: <T>(task: (lease: TranslationRequestLease) => Promise<T>, options: TranslationRequestAttemptOptions = {}) => enqueue({
            task: async lease => task(lease),
            signal: options.signal,
            deadlineAt: options.deadlineAt,
            identity: options.identity,
            attemptOnly: true,
            countConcurrency: options.countConcurrency === true,
            countRate: true,
            resolve: undefined as never,
            reject: undefined as never,
            settled: false,
        }),
    };
}
