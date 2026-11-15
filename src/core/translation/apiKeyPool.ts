/**
 * @file src/core/translation/apiKeyPool.ts
 * 文件职责：为同一服务的多个 API Key 提供不记录明文凭据的动态加权轮询算法。
 * 主要内容：维护权重、常数时间释放的并发租约计数、限流等待与恢复窗口，手动成功检查同步清除冷却，并按服务身份隔离有界状态。
 * 模块边界：只处理调用方提供的摘要身份和时间，不执行 HTTP、配置持久化或界面操作。
 */

import {DEFAULT_API_KEY_RECOVERY_MS} from '@/src/core/config/scheduling';

export const API_KEY_POOL_DEFAULT_WEIGHT = 4;
/** 未传入用户配置时使用的默认冷却恢复时间。 */
export const API_KEY_POOL_RECOVERY_MS = DEFAULT_API_KEY_RECOVERY_MS;

export type ApiKeyFailureKind =
  | 'transient'
  | 'network'
  | 'server'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'config'
  | 'cancelled';

export type ApiKeyFailureClass = 'cooldown' | 'penalty' | 'none';

export interface ApiKeyFailureInput {
  readonly kind?: ApiKeyFailureKind;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly code?: string;
  readonly name?: string;
  readonly message?: string;
}

export interface ApiKeyPoolOptions {
  readonly initialWeight?: number;
  readonly recoveryMs?: number;
  readonly maxOutstandingLeases?: number;
}

export interface ApiKeyLease {
  readonly keyId: string;
  readonly leaseId: number;
  readonly poolGeneration?: number;
}

export interface ApiKeyPoolState {
  readonly keyId: string;
  readonly weight: number;
  readonly current: number;
  readonly inFlight: boolean;
  readonly lastFailureAt: number | null;
  readonly cooldownUntil: number | null;
}

export class ApiKeyPoolExhaustedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`没有可用的 API key，请在 ${Math.max(1, retryAfterMs)} ms 后重试`);
    this.name = 'ApiKeyPoolExhaustedError';
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  }
}

interface KeyState {
  readonly keyId: string;
  weight: number;
  current: number;
  activeLeaseCount: number;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
  failureRevision: number;
}

export interface ApiKeyPool {
  lease(excludedKeyIds?: readonly string[], now?: number): ApiKeyLease;
  reportSuccess(lease: ApiKeyLease, now?: number): boolean;
  reportFailure(lease: ApiKeyLease, kind: ApiKeyFailureKind, now?: number, retryAfterMs?: number): boolean;
  reportSuccessForKey(keyId: string, now?: number): boolean;
  reportFailureForKey(keyId: string, kind: ApiKeyFailureKind, now?: number, retryAfterMs?: number): boolean;
  sync(keyIds: readonly string[]): void;
  getState(now?: number): readonly ApiKeyPoolState[];
}

export interface ApiKeyRotationOptions extends ApiKeyPoolOptions {
  /** 最多保留多少个 scope 的内存状态，避免动态配置导致无界增长。 */
  readonly maxScopes?: number;
}

export interface ApiKeyRotation {
  pick(scopeId: string, keyIds: readonly string[], excludedKeyIds?: readonly string[], now?: number): ApiKeyLease;
  success(scopeId: string, key: ApiKeyLease | string, now?: number): boolean;
  fail(scopeId: string, key: ApiKeyLease | string, kind: ApiKeyFailureKind, now?: number, retryAfterMs?: number): boolean;
  nextRetry(scopeId: string, keyIds: readonly string[], excludedKeyIds?: readonly string[], now?: number): number;
}

const NON_PENALIZING_FAILURES = new Set<ApiKeyFailureKind>(['config', 'cancelled']);
const ZERO_WEIGHT_FAILURES = new Set<ApiKeyFailureKind>(['auth', 'quota', 'rate-limit']);
let nextPoolGeneration = 1;

function normalizeCooldownMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1000, value) : fallback;
}

export function classifyApiKeyFailure(input: ApiKeyFailureInput): ApiKeyFailureClass {
  const kind = input.kind;
  if (kind === 'cancelled' || input.name === 'AbortError') return 'none';
  const code = input.code?.toLowerCase() ?? '';
  const message = input.message?.toLowerCase() ?? '';
  if (/(^|[_-])(api[_-]?key[_-]?invalid|invalid[_-]?api[_-]?key|invalid[_-]?token)([_-]|$)/.test(code)
    || /\b(?:api[ _-]?key|access token|auth token)\b.*\b(?:invalid|not valid|expired)\b|\b(?:invalid|expired)\b.*\b(?:api[ _-]?key|access token|auth token)\b|\btoken (?:is )?(?:invalid|not valid|expired)\b|\b(?:invalid|expired) token(?:[.!,:;]|$)/.test(message)) return 'cooldown';
  if (kind === 'config') return 'none';
  if (kind === 'auth' || kind === 'quota' || kind === 'rate-limit') return 'cooldown';
  if (/(^|[_-])(auth(?:entication|orization)?|quota|rate(?:[_-]?limit)?)([_-]|$)/.test(code)) return 'cooldown';
  if (input.statusCode === 401 || input.statusCode === 403 || input.statusCode === 429) return 'cooldown';
  if (kind === 'transient' || kind === 'network' || kind === 'server') return 'penalty';
  if (input.statusCode === 408 || input.statusCode === 425 || (input.statusCode !== undefined && input.statusCode >= 500)) return 'penalty';
  return 'none';
}

function normalizeWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return API_KEY_POOL_DEFAULT_WEIGHT;
  return Math.max(0, Math.floor(value));
}

function normalizeTime(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Date.now();
}

export function createApiKeyPool(
  keyIds: readonly string[],
  options: ApiKeyPoolOptions = {},
): ApiKeyPool {
  const initialWeight = normalizeWeight(options.initialWeight);
  const recoveryMs = options.recoveryMs === undefined || !Number.isFinite(options.recoveryMs)
    ? API_KEY_POOL_RECOVERY_MS
    : Math.max(0, options.recoveryMs);
  const keys: KeyState[] = [];
  const byId = new Map<string, KeyState>();
  for (const keyId of keyIds) {
    if (typeof keyId !== 'string' || !keyId.trim() || byId.has(keyId)) {
      throw new TypeError('API key pool 需要唯一且非空的 opaque id');
    }
    const state: KeyState = {keyId, weight: initialWeight, current: 0, activeLeaseCount: 0, lastFailureAt: null, cooldownUntil: null, failureRevision: 0};
    keys.push(state);
    byId.set(keyId, state);
  }
  let nextLeaseId = 1;
  const poolGeneration = nextPoolGeneration++;
  const activeLeases = new Map<number, {key: KeyState; failureRevision: number}>();
  const maxOutstandingLeases = options.maxOutstandingLeases === undefined || !Number.isFinite(options.maxOutstandingLeases)
    ? 4096
    : Math.max(1, Math.floor(options.maxOutstandingLeases));

  function recover(now: number): void {
    for (const key of keys) {
      if (key.cooldownUntil !== null && now >= key.cooldownUntil) {
        key.weight = initialWeight;
        key.current = 0;
        key.lastFailureAt = null;
        key.cooldownUntil = null;
      }
    }
  }

  function lease(excludedKeyIds: readonly string[] = [], nowInput?: number): ApiKeyLease {
    const now = normalizeTime(nowInput);
    recover(now);
    const excluded = new Set(excludedKeyIds);
    const candidates = keys.filter((key) => !excluded.has(key.keyId) && key.weight > 0);
    if (!candidates.length) {
      const retryAfter = keys
        .filter((key) => !excluded.has(key.keyId) && key.cooldownUntil !== null)
        .reduce((minimum, key) => Math.min(minimum, Math.max(1, (key.cooldownUntil as number) - now)), Infinity);
      throw new ApiKeyPoolExhaustedError(Number.isFinite(retryAfter) ? retryAfter : 1);
    }
    if (activeLeases.size >= maxOutstandingLeases) throw new ApiKeyPoolExhaustedError(1);
    const totalWeight = candidates.reduce((sum, key) => sum + key.weight, 0);
    let selected = candidates[0];
    for (const key of candidates) {
      key.current += key.weight;
      if (key.current > selected.current) selected = key;
    }
    selected.current -= totalWeight;
    const leaseId = nextLeaseId++;
    activeLeases.set(leaseId, {key: selected, failureRevision: selected.failureRevision});
    selected.activeLeaseCount += 1;
    return {keyId: selected.keyId, leaseId, poolGeneration};
  }

  function getLeaseState(lease: ApiKeyLease): KeyState | null {
    const entry = activeLeases.get(lease.leaseId);
    return entry && entry.key.keyId === lease.keyId && (lease.poolGeneration === undefined || lease.poolGeneration === poolGeneration) ? entry.key : null;
  }

  function finish(lease: ApiKeyLease): KeyState | null {
    const key = getLeaseState(lease);
    if (!key) return null;
    activeLeases.delete(lease.leaseId);
    key.activeLeaseCount -= 1;
    return key;
  }

  function reportSuccess(lease: ApiKeyLease, nowInput?: number): boolean {
    const leaseEntry = activeLeases.get(lease.leaseId);
    const key = finish(lease);
    if (!key) return false;
    recover(normalizeTime(nowInput));
    if (leaseEntry && leaseEntry.failureRevision !== key.failureRevision) return true;
    key.weight = Math.min(initialWeight, key.weight + 1);
    return true;
  }

  function reportFailure(lease: ApiKeyLease, kind: ApiKeyFailureKind, nowInput?: number, retryAfterMs?: number): boolean {
    const key = finish(lease);
    if (!key) return false;
    if (NON_PENALIZING_FAILURES.has(kind)) return false;
    const now = normalizeTime(nowInput);
    recover(now);
    key.lastFailureAt = now;
    key.failureRevision += 1;
    key.cooldownUntil = now + normalizeCooldownMs(retryAfterMs, recoveryMs);
    if (ZERO_WEIGHT_FAILURES.has(kind)) key.weight = 0;
    else key.weight = Math.floor(key.weight / 2);
    return true;
  }

  function reportSuccessForKey(keyId: string, nowInput?: number): boolean {
    const key = byId.get(keyId);
    if (!key) return false;
    recover(normalizeTime(nowInput));
    key.lastFailureAt = null;
    key.cooldownUntil = null;
    key.failureRevision += 1;
    key.weight = initialWeight;
    return true;
  }

  function reportFailureForKey(keyId: string, kind: ApiKeyFailureKind, nowInput?: number, retryAfterMs?: number): boolean {
    const key = byId.get(keyId);
    if (!key) return false;
    if (NON_PENALIZING_FAILURES.has(kind)) return false;
    const now = normalizeTime(nowInput);
    recover(now);
    key.lastFailureAt = now;
    key.failureRevision += 1;
    key.cooldownUntil = now + normalizeCooldownMs(retryAfterMs, recoveryMs);
    if (ZERO_WEIGHT_FAILURES.has(kind)) key.weight = 0;
    else key.weight = Math.floor(key.weight / 2);
    return true;
  }

  function getState(nowInput?: number): readonly ApiKeyPoolState[] {
    recover(normalizeTime(nowInput));
    return keys.map(({keyId, weight, current, activeLeaseCount, lastFailureAt, cooldownUntil}) => ({keyId, weight, current, inFlight: activeLeaseCount > 0, lastFailureAt, cooldownUntil}));
  }

  function sync(keyIds: readonly string[]): void {
    const next = new Set<string>();
    for (const keyId of keyIds) {
      if (typeof keyId !== 'string' || !keyId.trim() || next.has(keyId)) throw new TypeError('API key pool 需要唯一且非空的 opaque id');
      next.add(keyId);
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      if (!next.has(keys[index].keyId)) keys.splice(index, 1);
    }
    for (const [leaseId, entry] of activeLeases) if (!next.has(entry.key.keyId)) activeLeases.delete(leaseId);
    for (const keyId of keyIds) {
      if (!byId.has(keyId)) {
        const state: KeyState = {keyId, weight: initialWeight, current: 0, activeLeaseCount: 0, lastFailureAt: null, cooldownUntil: null, failureRevision: 0};
        keys.push(state);
        byId.set(keyId, state);
      }
    }
    for (const keyId of [...byId.keys()]) if (!next.has(keyId)) byId.delete(keyId);
  }

  return {lease, reportSuccess, reportFailure, reportSuccessForKey, reportFailureForKey, getState, sync};
}

/** 创建按 service/endpoint/model 等外部身份隔离的有界轮询管理器。 */
export function createApiKeyRotation(options: ApiKeyRotationOptions = {}): ApiKeyRotation {
  const maxScopes = options.maxScopes === undefined || !Number.isFinite(options.maxScopes)
    ? 64
    : Math.max(1, Math.floor(options.maxScopes));
  const pools = new Map<string, {pool: ApiKeyPool; touchedAt: number}>();

  function getPool(scopeId: string, keyIds: readonly string[], now: number): ApiKeyPool {
    if (typeof scopeId !== 'string' || !scopeId.trim()) throw new TypeError('API key rotation 需要非空 scope id');
    let entry = pools.get(scopeId);
    if (!entry) {
      if (pools.size >= maxScopes) {
        const oldest = [...pools.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]!;
        pools.delete(oldest[0]);
      }
      entry = {pool: createApiKeyPool(keyIds, options), touchedAt: now};
      pools.set(scopeId, entry);
    } else {
      entry.touchedAt = now;
      entry.pool.sync(keyIds);
    }
    return entry.pool;
  }

  return {
    pick(scopeId, keyIds, excludedKeyIds = [], nowInput) {
      const now = normalizeTime(nowInput);
      return getPool(scopeId, keyIds, now).lease(excludedKeyIds, now);
    },
    success(scopeId, key, nowInput) {
      const now = normalizeTime(nowInput);
      const entry = pools.get(scopeId);
      if (!entry) return false;
      if (typeof key === 'string') return entry.pool.reportSuccessForKey(key, now);
      return entry.pool.reportSuccess(key, now);
    },
    fail(scopeId, key, kind, nowInput, retryAfterMs) {
      const now = normalizeTime(nowInput);
      const entry = pools.get(scopeId);
      if (!entry) return false;
      if (typeof key === 'string') return entry.pool.reportFailureForKey(key, kind, now, retryAfterMs);
      return entry.pool.reportFailure(key, kind, now, retryAfterMs);
    },
    nextRetry(scopeId, keyIds, excludedKeyIds = [], nowInput) {
      const now = normalizeTime(nowInput);
      const pool = getPool(scopeId, keyIds, now);
      const excluded = new Set(excludedKeyIds);
      const states = pool.getState(now).filter((state) => !excluded.has(state.keyId));
      if (states.some((state) => state.weight > 0)) return 0;
      const retryAfter = states
        .filter((state) => state.cooldownUntil !== null)
        .reduce((minimum, state) => Math.min(minimum, Math.max(1, (state.cooldownUntil as number) - now)), Infinity);
      return Number.isFinite(retryAfter) ? retryAfter : 1;
    },
  };
}
