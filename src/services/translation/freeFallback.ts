/**
 * @file src/services/translation/freeFallback.ts
 * 文件职责：在健康免费服务间加权均衡并自动回退，持久遵守各类错误的恢复窗口。
 * 主要内容：协调总预算、单次超时、服务并发与间隔、错误退避、恢复单探测、持久化、取消代际保护，并向调用方旁路上报每次线路尝试的结果与耗时。
 * 模块边界：只接收匿名身份、provider 回调和注入的存储端口；不读取用户配置或供应商凭据。
 */
import {abortErrorFromSignal} from '@/src/platform/http/runtime';
import {FREE_TRANSLATION_TOTAL_TIMEOUT_MS} from '@/src/core/config/freeTranslation';
import {
    getFreeFailureStatus, getFreeFailureCooldown, selectWeightedFreeCandidate,
    MAX_FREE_COOLDOWN_MS, type FreeFailureCategory,
    getDynamicFreeProviderWeight, observeFreeProviderPerformance, type FreeProviderPerformance,
} from './freeRoutingPolicy';

export interface FreeFallbackCandidate {
    readonly identity: string;
    readonly label: string;
    readonly weight?: number;
    readonly maxConcurrency?: number;
    readonly minIntervalMs?: number;
    readonly translate: (signal: AbortSignal) => Promise<unknown>;
}
export type FreeFallbackAttemptOutcome = 'success' | 'error' | 'timeout' | 'cancelled';
export interface FreeFallbackAttempt {
    readonly identity: string;
    readonly outcome: FreeFallbackAttemptOutcome;
    readonly durationMs: number;
}
export interface FreeFallbackOptions {
    readonly signal?: AbortSignal;
    /** 每次真实线路尝试结束后的旁路观察；只接收身份、结果和耗时。 */
    readonly onAttempt?: (attempt: FreeFallbackAttempt) => void;
    readonly timeoutMs: number;
    readonly cooldownMs: number;
    readonly mode?: 'balanced' | 'sequential';
    /** 同一批次共享截止时间，排队与各备用服务共同消费预算。 */
    readonly deadline?: number;
}
export interface PersistedFreeHealth {
    identity: string;
    retryAt: number;
    failures: number;
    category: FreeFailureCategory;
    performance?: FreeProviderPerformance;
}
export interface FreeHealthPersistence {
    load(): Promise<unknown>;
    save(entries: readonly PersistedFreeHealth[]): Promise<void>;
}
export interface FreeFallbackDependencies {
    readonly random?: () => number;
    readonly persistence?: FreeHealthPersistence;
}
export interface FreeFallbackRunner {
    (candidates: readonly FreeFallbackCandidate[], options: FreeFallbackOptions): Promise<string>;
    /** 读取当前后台 worker 的健康快照；快照只包含服务身份摘要和时间/性能数据。 */
    getHealthSnapshot(): Promise<readonly PersistedFreeHealth[]>;
}
interface Health {
    retryAt: number;
    generation: number;
    probing: boolean;
    failures: number;
    category: FreeFailureCategory;
    active: number;
    nextAttemptAt: number;
    performance?: FreeProviderPerformance;
}
class AttemptTimeoutError extends Error { constructor() { super('请求超时'); } }

function attemptOutcome(error: unknown, signal?: AbortSignal): FreeFallbackAttemptOutcome {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return 'cancelled';
    return error instanceof AttemptTimeoutError ? 'timeout' : 'error';
}
class InvalidTranslationError extends Error { constructor() { super('未返回有效译文'); } }

function safeFailure(error: unknown): string {
    const status = getFreeFailureStatus(error);
    if (status !== undefined) return `HTTP ${status}`;
    if (error instanceof AttemptTimeoutError || error instanceof InvalidTranslationError) return error.message;
    return '请求失败';
}

async function runAttempt(candidate: FreeFallbackCandidate, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const result = new Promise<string>((resolve, reject) => {
        onAbort = () => { reject(abortErrorFromSignal(signal!)); controller.abort(signal?.reason); };
        signal?.addEventListener('abort', onAbort, {once: true});
        timer = setTimeout(() => { reject(new AttemptTimeoutError()); controller.abort(); }, timeoutMs);
        Promise.resolve().then(() => {
            if (controller.signal.aborted) throw abortErrorFromSignal(controller.signal);
            return candidate.translate(controller.signal);
        }).then(value => {
            if (typeof value !== 'string' || !value.trim()) reject(new InvalidTranslationError());
            else resolve(value);
        }, reject);
    });
    try { return await result; }
    finally { clearTimeout(timer!); signal?.removeEventListener('abort', onAbort!); }
}

/** 存储故障或挂起不阻断翻译；迟到的加载值不会覆盖已开始服务的健康状态。 */
async function boundedStorage<T>(request: Promise<T>, limitMs = 1000, signal?: AbortSignal): Promise<T | undefined> {
    // 调用方已在同一同步段检查取消；此处只监听等待期间发生的取消。
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            request.catch(() => undefined),
            new Promise<undefined>((resolve, reject) => {
                timer = setTimeout(() => resolve(undefined), Math.max(0, limitMs));
                onAbort = () => reject(abortErrorFromSignal(signal!));
                signal?.addEventListener('abort', onAbort, {once: true});
            }),
        ]);
    } finally { clearTimeout(timer!); if (onAbort) signal?.removeEventListener('abort', onAbort); }
}

export function createFreeFallbackRunner(maxConcurrency = 3, dependencies: FreeFallbackDependencies = {}): FreeFallbackRunner {
    const health = new Map<string, Health>();
    const queue: Array<() => void> = [];
    const availabilityWaiters = new Set<() => void>();
    const concurrency = Math.max(1, Math.floor(maxConcurrency));
    const random = dependencies.random ?? Math.random;
    let active = 0;
    let previous: string | undefined;
    let loaded: Promise<void> | undefined;
    let saving: Promise<void> | undefined;
    let pendingSave: readonly PersistedFreeHealth[] | undefined;

    function getHealth(identity: string): Health {
        let state = health.get(identity);
        if (!state) {
            state = {retryAt: 0, generation: 0, probing: false, failures: 0, category: 'unavailable', active: 0, nextAttemptAt: 0};
            health.set(identity, state);
            if (health.size > 128) {
                const evict = [...health].find(([key, item]) => key !== identity && !item.active && !item.probing);
                if (evict) health.delete(evict[0]);
            }
        } else {
            health.delete(identity);
            health.set(identity, state);
        }
        return state;
    }

    async function loadHealth(): Promise<void> {
        loaded ??= (async () => {
            const entries = await boundedStorage(Promise.resolve().then(() => dependencies.persistence!.load()));
            if (!Array.isArray(entries)) return;
            for (const entry of entries.slice(0, 128)) {
                if (!entry || typeof entry !== 'object') continue;
                const {identity, retryAt, failures, category, performance} = entry as Partial<PersistedFreeHealth>;
                const validPerformance = performance && typeof performance === 'object'
                    && Number.isFinite(performance.reliability) && performance.reliability >= 0 && performance.reliability <= 1
                    && Number.isFinite(performance.latencyMs) && performance.latencyMs >= 1 && performance.latencyMs <= 60_000
                    && Number.isFinite(performance.observedAt) && performance.observedAt >= 0;
                if (typeof identity !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/u.test(identity)
                    || typeof retryAt !== 'number' || !Number.isFinite(retryAt) || retryAt < 0
                    || typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0 || failures > 100
                    || (failures === 0 && !validPerformance)
                    || !['rate-limit', 'quota', 'blocked', 'unavailable', 'request'].includes(category as string)) continue;
                const state = getHealth(identity);
                state.retryAt = Math.min(retryAt, Date.now() + MAX_FREE_COOLDOWN_MS);
                state.failures = failures;
                state.category = category!;
                if (validPerformance) state.performance = {
                    reliability: performance.reliability, latencyMs: performance.latencyMs,
                    observedAt: Math.min(Date.now(), performance.observedAt),
                };
            }
        })();
        await loaded;
    }

    async function persistHealth(deadline: number, signal?: AbortSignal): Promise<void> {
        const persistence = dependencies.persistence;
        if (!persistence) return;
        pendingSave = [...health].filter(([, item]) => item.failures > 0 || item.performance).slice(-128)
            .map(([identity, item]) => ({identity, retryAt: item.retryAt, failures: item.failures, category: item.category,
                ...(item.performance ? {performance: {...item.performance}} : {}),
            }));
        // 写入按变更顺序串行，旧失败不能在恢复成功之后把冷却写回磁盘。
        // 挂起期间只保留最新快照，不为每个失败段落积累 Promise/旧状态队列。
        saving ??= Promise.resolve().then(async () => {
            while (pendingSave) {
                const entries = pendingSave;
                pendingSave = undefined;
                try { await persistence.save(entries); } catch { /* 存储失败不阻断翻译。 */ }
            }
        }).finally(() => { saving = undefined; });
        await boundedStorage(saving, Math.min(1000, deadline - Date.now()), signal);
    }

    async function acquire(deadline: number, signal?: AbortSignal): Promise<() => void> {
        if (Date.now() >= deadline) throw new AttemptTimeoutError();
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        if (active >= concurrency) {
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    const index = queue.indexOf(onReady);
                    if (index >= 0) queue.splice(index, 1);
                };
                const onReady = () => { cleanup(); resolve(); };
                const onAbort = () => { cleanup(); reject(abortErrorFromSignal(signal!)); };
                const timer = setTimeout(() => { cleanup(); reject(new AttemptTimeoutError()); }, Math.max(1, deadline - Date.now()));
                signal?.addEventListener('abort', onAbort, {once: true});
                queue.push(onReady);
            });
        } else active += 1;
        return () => { const next = queue.shift(); if (next) next(); else active -= 1; };
    }

    async function waitForAvailability(durationMs: number, signal?: AbortSignal): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); availabilityWaiters.delete(wake); signal?.removeEventListener('abort', onAbort); };
            const wake = () => { cleanup(); resolve(); };
            const onAbort = () => { cleanup(); reject(abortErrorFromSignal(signal!)); };
            const timer = setTimeout(wake, Math.max(1, durationMs));
            availabilityWaiters.add(wake);
            signal?.addEventListener('abort', onAbort, {once: true});
        });
    }

    const execute = async (candidates: readonly FreeFallbackCandidate[], options: FreeFallbackOptions): Promise<string> => {
        if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
        if (!candidates.length) throw new Error('免费翻译服务均不可用：未选择可用的免密钥服务');
        const deadline = options.deadline ?? Date.now() + FREE_TRANSLATION_TOTAL_TIMEOUT_MS;
        if (dependencies.persistence) await boundedStorage(loadHealth(), Math.min(1000, deadline - Date.now()), options.signal);
        const release = await acquire(deadline, options.signal);
        const attempted = new Set<string>();
        const failures: string[] = [];
        try {
            while (attempted.size < new Set(candidates.map(item => item.identity)).size) {
                if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new AttemptTimeoutError();
                const pending = candidates.filter(candidate => !attempted.has(candidate.identity));
                const ready = pending.filter(candidate => {
                    const state = getHealth(candidate.identity);
                    return state.retryAt <= Date.now() && !state.probing
                        && state.active < (candidate.maxConcurrency ?? Infinity) && state.nextAttemptAt <= Date.now();
                });
                if (!ready.length) {
                    const waiting = pending.filter(candidate => getHealth(candidate.identity).retryAt <= Date.now());
                    if (!waiting.length) break;
                    const nextInterval = Math.min(...waiting.map(candidate => {
                        const time = getHealth(candidate.identity).nextAttemptAt - Date.now();
                        return time > 0 ? time : remaining;
                    }));
                    await waitForAvailability(Math.min(remaining, nextInterval), options.signal);
                    continue;
                }
                const weighted = ready.map(candidate => ({...candidate,
                    weight: getDynamicFreeProviderWeight(candidate.weight ?? 1, getHealth(candidate.identity).performance, Date.now()),
                }));
                const candidate = options.mode === 'balanced' && previous
                    ? selectWeightedFreeCandidate(weighted, random(), previous)! : weighted[0]!;
                previous = candidate.identity;
                attempted.add(candidate.identity);
                const state = getHealth(candidate.identity);
                const generation = state.generation;
                const probing = state.retryAt !== 0;
                if (probing) state.probing = true;
                state.active += 1;
                state.nextAttemptAt = Date.now() + Math.max(0, candidate.minIntervalMs ?? 0);
                const startedAt = Date.now();
                try {
                    const result = await runAttempt(candidate, Math.min(options.timeoutMs, remaining), options.signal);
                    options.onAttempt?.({identity: candidate.identity, outcome: 'success', durationMs: Date.now() - startedAt});
                    if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
                    state.generation += 1;
                    state.retryAt = 0;
                    state.failures = 0;
                    state.performance = observeFreeProviderPerformance(state.performance, true, Date.now() - startedAt, Date.now());
                    await persistHealth(deadline, options.signal);
                    if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
                    return result;
                } catch (error) {
                    options.onAttempt?.({identity: candidate.identity, outcome: attemptOutcome(error, options.signal), durationMs: Date.now() - startedAt});
                    if (options.signal?.aborted) throw abortErrorFromSignal(options.signal);
                    if (error instanceof Error && error.name === 'AbortError') throw error;
                    if (error instanceof AttemptTimeoutError && remaining < options.timeoutMs && Date.now() >= deadline) throw error;
                    if (state.generation === generation) {
                        const cooldown = getFreeFailureCooldown(error, state.failures + 1, options.cooldownMs, random());
                        // 任意一次真实 provider 失败都先快速摘除；request 类错误也需要短暂冷却，
                        // 避免同一服务在下一段文本中持续消耗尝试机会。取消不经过这里。
                        const durationMs = cooldown.durationMs > 0
                            ? cooldown.durationMs
                            : Math.max(1_000, Number.isFinite(options.cooldownMs) ? options.cooldownMs : 1_000);
                        state.performance = observeFreeProviderPerformance(state.performance, false, Date.now() - startedAt, Date.now());
                        state.generation += 1;
                        state.retryAt = Date.now() + durationMs;
                        state.failures = Math.min(100, state.failures + 1);
                        state.category = cooldown.category;
                        await persistHealth(deadline, options.signal);
                    }
                    failures.push(`${candidate.label}: ${safeFailure(error)}`);
                } finally {
                    state.active -= 1;
                    if (probing) state.probing = false;
                    [...availabilityWaiters].forEach(wake => wake());
                }
            }
            const reason = failures.length ? failures.join('；') : '所选服务正在冷却，请稍后重试';
            throw new Error(`免费翻译服务均不可用：${reason}`);
        } finally { release(); }
    };

    const getHealthSnapshot = async (): Promise<readonly PersistedFreeHealth[]> => {
        if (dependencies.persistence) await boundedStorage(loadHealth(), 1_000);
        return [...health]
            .filter(([, item]) => item.failures > 0 || item.performance)
            .map(([identity, item]) => ({
                identity,
                retryAt: item.retryAt,
                failures: item.failures,
                category: item.category,
                ...(item.performance ? {performance: {...item.performance}} : {}),
            }));
    };
    return Object.assign(execute, {getHealthSnapshot});
}
