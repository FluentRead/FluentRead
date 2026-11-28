/**
 * @file src/core/tts/backoff.ts
 * 文件职责：提供 TTS 多源合成的纯错误分类、抖动指数退避、源级熔断冷却与音色级降级策略。
 * 主要内容：定义失败类别与健康快照，导出 classifyTtsError、computeTtsBackoffMs 和 TtsCircuitBreaker，支持 Retry-After 尊重、半开探测、EWMA 延迟记录与无效音色短期隔离。
 * 模块边界：本文件属于 core 纯领域层，不发起网络请求、不读写浏览器存储也不持有全局单例；时钟与随机数源可注入，供后台 TTS 编排与单测复用。
 */

export type TtsSourceId = 'edge' | 'youdao' | 'google' | 'openai' | 'local' | 'browser';

export type TtsFailureKind =
    | 'abort'
    | 'rate-limit'
    | 'auth'
    | 'client'
    | 'server'
    | 'timeout'
    | 'network'
    | 'unsupported'
    | 'unknown';

export interface TtsClassifiedError {
    readonly kind: TtsFailureKind;
    readonly statusCode?: number;
    readonly retryAfterMs?: number;
    readonly retryable: boolean;
    readonly tripsSource: boolean;
    readonly tripsVoice: boolean;
}

export interface TtsCircuitPolicy {
    readonly baseCooldownMs: number;
    readonly maxCooldownMs: number;
    readonly failureThreshold: number;
    readonly voiceCooldownMs: number;
    readonly baseBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly ewmaAlpha: number;
}

export interface TtsSourceHealthSnapshot {
    readonly source: TtsSourceId;
    readonly state: 'closed' | 'open' | 'half-open';
    readonly consecutiveFailures: number;
    readonly cooldownRemainingMs: number;
    readonly ewmaLatencyMs: number | null;
    readonly lastFailureKind: TtsFailureKind | null;
}

interface SourceHealthRecord {
    consecutiveFailures: number;
    cooldownUntil: number;
    ewmaLatencyMs: number | null;
    lastFailureKind: TtsFailureKind | null;
    halfOpenProbeInFlight: boolean;
}

export const DEFAULT_TTS_CIRCUIT_POLICY: Readonly<TtsCircuitPolicy> = Object.freeze({
    baseCooldownMs: 15_000,
    maxCooldownMs: 300_000,
    failureThreshold: 2,
    voiceCooldownMs: 10 * 60_000,
    baseBackoffMs: 250,
    maxBackoffMs: 4_000,
    ewmaAlpha: 0.3,
});

function readOptionalNumber(value: unknown, field: string): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = (value as Record<string, unknown>)[field];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function readOptionalString(value: unknown, field: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = (value as Record<string, unknown>)[field];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** 将 HTTP、超时、网络、取消与不支持类 TTS 异常归类为可决策的失败语义。 */
export function classifyTtsError(error: unknown): TtsClassifiedError {
    const name = readOptionalString(error, 'name') ?? '';
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const code = readOptionalString(error, 'code');
    const statusCode = readOptionalNumber(error, 'statusCode');
    const retryAfterMs = readOptionalNumber(error, 'retryAfterMs');

    if (name === 'AbortError') {
        return {kind: 'abort', retryable: false, tripsSource: false, tripsVoice: false};
    }
    if (name === 'TimeoutError' || /timeout|timed out|超时/iu.test(message)) {
        return {kind: 'timeout', statusCode, retryAfterMs, retryable: true, tripsSource: true, tripsVoice: false};
    }
    if (code === 'local-tts-language-unsupported'
        || code === 'local-tts-model-not-downloaded'
        || code === 'tts-language-unsupported'
        || code === 'tts-openai-key-missing'
        || code === 'tts-text-too-long'
        || /unavailable for this language|unsupported language|text is too long|暂不支持/iu.test(message)) {
        return {kind: 'unsupported', statusCode, retryable: false, tripsSource: false, tripsVoice: false};
    }
    if (statusCode !== undefined) {
        if (statusCode === 429) {
            return {kind: 'rate-limit', statusCode, retryAfterMs, retryable: true, tripsSource: true, tripsVoice: false};
        }
        if (statusCode === 401 || statusCode === 403) {
            return {kind: 'auth', statusCode, retryAfterMs, retryable: false, tripsSource: true, tripsVoice: false};
        }
        if (statusCode >= 500 && statusCode <= 599) {
            return {kind: 'server', statusCode, retryAfterMs, retryable: true, tripsSource: true, tripsVoice: false};
        }
        if (statusCode >= 400 && statusCode <= 499) {
            return {kind: 'client', statusCode, retryAfterMs, retryable: false, tripsSource: false, tripsVoice: true};
        }
    }
    if (name === 'TypeError' || /failed to fetch|network|econn|dns|offline|socket|fetch failed/iu.test(message)) {
        return {kind: 'network', retryable: true, tripsSource: true, tripsVoice: false};
    }
    return {kind: 'unknown', statusCode, retryAfterMs, retryable: false, tripsSource: true, tripsVoice: false};
}

/** 计算带等量抖动的指数退避毫秒数；非瞬态错误返回 0，优先尊重服务端 Retry-After。 */
export function computeTtsBackoffMs(
    attempt: number,
    kind: TtsFailureKind,
    retryAfterMs?: number,
    random: () => number = Math.random,
    policy: Pick<TtsCircuitPolicy, 'baseBackoffMs' | 'maxBackoffMs'> = DEFAULT_TTS_CIRCUIT_POLICY,
): number {
    if (kind !== 'rate-limit' && kind !== 'server' && kind !== 'timeout' && kind !== 'network') {
        return 0;
    }
    const safeAttempt = Math.max(0, Math.floor(Number.isFinite(attempt) ? attempt : 0));
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(Math.round(retryAfterMs), policy.maxBackoffMs);
    }
    const exponential = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** Math.min(safeAttempt, 6));
    const clampedRandom = Math.min(1, Math.max(0, random()));
    // Equal jitter: [exponential / 2, exponential]，避免重试风暴同时保证最低退避。
    return Math.round(exponential * (0.5 + 0.5 * clampedRandom));
}

export interface TtsCircuitBreakerOptions {
    readonly policy?: Partial<TtsCircuitPolicy>;
    readonly now?: () => number;
}

/**
 * 维护 TTS 源与单音色的健康状态机：
 * - 连续失败达到阈值或遭遇限流/鉴权失败时进入冷却（open）
 * - 冷却结束后仅允许一次半开探测（half-open），成功即恢复，失败则翻倍冷却
 * - 单个失效音色独立冷却，不连累同源其余可用音色
 */
export class TtsCircuitBreaker {
    private readonly policy: TtsCircuitPolicy;
    private readonly now: () => number;
    private readonly sources = new Map<TtsSourceId, SourceHealthRecord>();
    private readonly voiceCooldowns = new Map<string, number>();

    constructor(options: TtsCircuitBreakerOptions = {}) {
        this.policy = {...DEFAULT_TTS_CIRCUIT_POLICY, ...options.policy};
        this.now = options.now ?? (() => Date.now());
    }

    private ensureSource(source: TtsSourceId): SourceHealthRecord {
        let record = this.sources.get(source);
        if (!record) {
            record = {
                consecutiveFailures: 0,
                cooldownUntil: 0,
                ewmaLatencyMs: null,
                lastFailureKind: null,
                halfOpenProbeInFlight: false,
            };
            this.sources.set(source, record);
        }
        return record;
    }

    /** 判断来源当前是否允许发起请求（含半开单探测放行）。 */
    canAttemptSource(source: TtsSourceId): boolean {
        const record = this.sources.get(source);
        if (!record || record.cooldownUntil <= 0) return true;
        const current = this.now();
        if (current < record.cooldownUntil) return false;
        return !record.halfOpenProbeInFlight;
    }

    /** 标记即将对已过冷却期的来源发起半开探测。 */
    beginAttempt(source: TtsSourceId): void {
        const record = this.sources.get(source);
        if (record && record.cooldownUntil > 0 && this.now() >= record.cooldownUntil) {
            record.halfOpenProbeInFlight = true;
        }
    }

    /** 取消一次未结算的半开探测，避免 AbortError 永久锁死探测资格。 */
    cancelAttempt(source: TtsSourceId): void {
        const record = this.sources.get(source);
        if (record) record.halfOpenProbeInFlight = false;
    }

    /** 记录来源成功并更新 EWMA 延迟。 */
    recordSourceSuccess(source: TtsSourceId, latencyMs?: number): void {
        const record = this.ensureSource(source);
        record.consecutiveFailures = 0;
        record.cooldownUntil = 0;
        record.lastFailureKind = null;
        record.halfOpenProbeInFlight = false;
        if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
            record.ewmaLatencyMs = record.ewmaLatencyMs === null
                ? latencyMs
                : record.ewmaLatencyMs * (1 - this.policy.ewmaAlpha) + latencyMs * this.policy.ewmaAlpha;
        }
    }

    /** 记录来源失败；返回分类结果，并在达到阈值、限流或鉴权失败时进入冷却。 */
    recordSourceFailure(source: TtsSourceId, error: unknown): TtsClassifiedError {
        const classified = classifyTtsError(error);
        const record = this.ensureSource(source);
        record.halfOpenProbeInFlight = false;
        if (!classified.tripsSource) return classified;

        record.consecutiveFailures += 1;
        record.lastFailureKind = classified.kind;
        const immediateTrip = classified.kind === 'rate-limit' || classified.kind === 'auth';
        if (immediateTrip || record.consecutiveFailures >= this.policy.failureThreshold) {
            const exponent = Math.max(0, record.consecutiveFailures - (immediateTrip ? 1 : this.policy.failureThreshold));
            const computed = Math.min(this.policy.maxCooldownMs, this.policy.baseCooldownMs * 2 ** Math.min(exponent, 5));
            const retryAfter = classified.retryAfterMs !== undefined
                ? Math.min(this.policy.maxCooldownMs, Math.max(this.policy.baseCooldownMs, classified.retryAfterMs))
                : 0;
            record.cooldownUntil = this.now() + Math.max(computed, retryAfter);
        }
        return classified;
    }

    /** 记录特定音色不可用（如 400/404 音色下线），将其临时降权隔离。 */
    recordVoiceFailure(voice: string): void {
        const trimmed = voice.trim();
        if (!trimmed) return;
        this.voiceCooldowns.set(trimmed, this.now() + this.policy.voiceCooldownMs);
    }

    /** 检查音色当前是否处于冷却中。 */
    isVoiceInCooldown(voice: string): boolean {
        const until = this.voiceCooldowns.get(voice);
        if (until === undefined) return false;
        if (this.now() >= until) {
            this.voiceCooldowns.delete(voice);
            return false;
        }
        return true;
    }

    /** 过滤冷却中的音色；若全部都在冷却中则保留原顺序作为兜底探测。 */
    orderVoices(voices: readonly string[]): string[] {
        const healthy: string[] = [];
        const cooled: string[] = [];
        for (const voice of voices) {
            if (this.isVoiceInCooldown(voice)) cooled.push(voice);
            else healthy.push(voice);
        }
        return healthy.length > 0 ? [...healthy, ...cooled] : [...voices];
    }

    /**
     * 按配置顺序选出当前可尝试的来源；若所有来源都在冷却中，按剩余冷却时间升序返回非探测中的来源，
     * 避免并发双半开探测及单语种不支持源饿死其他可用源。
     */
    selectSources(configured: readonly TtsSourceId[]): TtsSourceId[] {
        if (configured.length === 0) return [];
        const ready = configured.filter((source) => this.canAttemptSource(source));
        if (ready.length > 0) return ready;
        const current = this.now();
        const nonProbing = configured.filter((source) => !this.sources.get(source)?.halfOpenProbeInFlight);
        const candidates = nonProbing.length > 0 ? nonProbing : [...configured];
        return candidates.sort((left, right) => {
            const leftWait = Math.max(0, this.sources.get(left)!.cooldownUntil - current);
            const rightWait = Math.max(0, this.sources.get(right)!.cooldownUntil - current);
            return leftWait - rightWait;
        });
    }

    getSnapshot(sources: readonly TtsSourceId[]): TtsSourceHealthSnapshot[] {
        const current = this.now();
        return sources.map((source) => {
            const record = this.sources.get(source);
            if (!record) {
                return {
                    source,
                    state: 'closed',
                    consecutiveFailures: 0,
                    cooldownRemainingMs: 0,
                    ewmaLatencyMs: null,
                    lastFailureKind: null,
                };
            }
            const remaining = Math.max(0, record.cooldownUntil - current);
            const state = record.cooldownUntil <= 0
                ? 'closed'
                : remaining > 0
                    ? 'open'
                    : 'half-open';
            return {
                source,
                state,
                consecutiveFailures: record.consecutiveFailures,
                cooldownRemainingMs: remaining,
                ewmaLatencyMs: record.ewmaLatencyMs === null ? null : Math.round(record.ewmaLatencyMs),
                lastFailureKind: record.lastFailureKind,
            };
        });
    }

    reset(): void {
        this.sources.clear();
        this.voiceCooldowns.clear();
    }
}
