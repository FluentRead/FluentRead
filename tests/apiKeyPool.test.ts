/**
 * @file tests/apiKeyPool.test.ts
 * @职责 覆盖 API key 动态轮询的公平性、降权、恢复、并发租约和安全错误边界。
 */

import {describe, expect, it, vi} from 'vitest';
import {
  API_KEY_POOL_DEFAULT_WEIGHT,
  API_KEY_POOL_RECOVERY_MS,
  ApiKeyPoolExhaustedError,
  classifyApiKeyFailure,
  createApiKeyRotation,
  createApiKeyPool,
} from '@/src/core/translation/apiKeyPool';

describe('createApiKeyPool', () => {
  it('大量并发租约完成时不遍历其他租约，重复结算也不能提前清除在途状态', () => {
    const pool = createApiKeyPool(['a', 'b']);
    const leases = Array.from({length: 2000}, () => pool.lease([], 0));
    const traversal = vi.spyOn(Map.prototype, 'values');
    try {
      for (const lease of leases.slice(0, -2)) {
        pool.reportSuccess(lease, 0);
        pool.reportSuccess(lease, 0);
      }
      expect(traversal).not.toHaveBeenCalled();
      expect(pool.getState(0).map(state => state.inFlight)).toEqual([true, true]);
      pool.reportFailure(leases[leases.length - 2], 'cancelled', 0);
      expect(pool.getState(0).map(state => state.inFlight)).toEqual([false, true]);
      pool.reportSuccess(leases[leases.length - 1], 0);
      expect(pool.getState(0).every(state => !state.inFlight)).toBe(true);
    } finally {
      traversal.mockRestore();
    }
  });

  it('主动检测成功后完整清除旧冷却状态', () => {
    const pool = createApiKeyPool(['a']);
    pool.reportFailureForKey('a', 'auth', 100);
    expect(pool.getState(100)[0].cooldownUntil).toBe(100 + API_KEY_POOL_RECOVERY_MS);
    pool.reportSuccessForKey('a', 101);
    expect(pool.getState(101)[0]).toMatchObject({lastFailureAt: null, cooldownUntil: null, weight: API_KEY_POOL_DEFAULT_WEIGHT});
    expect(pool.lease([], 101).keyId).toBe('a');
  });
  it('starts equal and uses smooth weighted rotation', () => {
    const pool = createApiKeyPool(['a', 'b', 'c']);
    const ids = Array.from({length: 6}, () => {
      const lease = pool.lease();
      pool.reportSuccess(lease, 0);
      return lease.keyId;
    });
    expect(ids).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(pool.getState(0).every((item) => item.weight === API_KEY_POOL_DEFAULT_WEIGHT)).toBe(true);
  });

  it('penalizes transient failures progressively and rotates immediately', () => {
    const pool = createApiKeyPool(['a', 'b']);
    let lease = pool.lease([], 0);
    expect(lease.keyId).toBe('a');
    expect(pool.reportFailure(lease, 'transient', 0)).toBe(true);
    expect(pool.getState(0).find((item) => item.keyId === 'a')?.weight).toBe(2);
    lease = pool.lease([], 0);
    expect(lease.keyId).toBe('b');
    pool.reportFailure(lease, 'transient', 0);
    lease = pool.lease([], 0);
    pool.reportFailure(lease, 'transient', 0);
    lease = pool.lease([], 0);
    pool.reportFailure(lease, 'transient', 0);
    expect(pool.getState(0).find((item) => item.keyId === 'a')?.weight).toBeLessThan(API_KEY_POOL_DEFAULT_WEIGHT);
  });

  it('zeros auth, quota, and rate-limit failures, while config and cancellation do not penalize', () => {
    for (const kind of ['auth', 'quota', 'rate-limit'] as const) {
      const single = createApiKeyPool(['only']);
      const lease = single.lease([], 0);
      single.reportFailure(lease, kind, 0);
      expect(single.getState(0)[0].weight).toBe(0);
      expect(() => single.lease([], 0)).toThrow(ApiKeyPoolExhaustedError);
    }
    const other = createApiKeyPool(['a']);
    const lease = other.lease([], 0);
    expect(other.reportFailure(lease, 'config', 0)).toBe(false);
    const configLease = other.lease([], 0);
    expect(configLease.keyId).toBe('a');
    expect(other.reportFailure(configLease, 'config', 0)).toBe(false);
    const lease2 = other.lease([], 1);
    expect(other.reportFailure(lease2, 'cancelled', 1)).toBe(false);
    expect(other.getState(1)[0].weight).toBe(API_KEY_POOL_DEFAULT_WEIGHT);
  });

  it('recovers all failed keys after one minute and exposes a retry hint', () => {
    const pool = createApiKeyPool(['a']);
    const lease = pool.lease([], 100);
    pool.reportFailure(lease, 'auth', 100);
    expect(() => pool.lease([], 100)).toThrowError(/重试/);
    try { pool.lease([], 100); } catch (error) {
      expect(error).toBeInstanceOf(ApiKeyPoolExhaustedError);
      expect((error as ApiKeyPoolExhaustedError).retryAfterMs).toBe(API_KEY_POOL_RECOVERY_MS);
    }
    expect(pool.lease([], 100 + API_KEY_POOL_RECOVERY_MS).keyId).toBe('a');
    expect(pool.getState(100 + API_KEY_POOL_RECOVERY_MS)[0].weight).toBe(API_KEY_POOL_DEFAULT_WEIGHT);
  });

  it('allows concurrent reuse, honors per-request exclusions, and rejects bad ids', () => {
    const pool = createApiKeyPool(['a', 'b']);
    const first = pool.lease([], 0);
    const second = pool.lease([], 0);
    expect(second.keyId).toBe('b');
    const third = pool.lease([], 0);
    expect(third.keyId).toBe('a');
    expect(() => pool.lease(['a', 'b'], 0)).toThrow(ApiKeyPoolExhaustedError);
    expect(pool.reportSuccess({keyId: 'a', leaseId: first.leaseId + 1}, 0)).toBe(false);
    expect(pool.reportSuccess(first, 0)).toBe(true);
    expect(pool.reportFailure(first, 'server', 0)).toBe(false);
    expect(pool.reportSuccess(third, 0)).toBe(true);
    expect(pool.reportSuccess(second, 0)).toBe(true);
    expect(pool.reportSuccess(first, 0)).toBe(false);
    expect(() => createApiKeyPool(['a', 'a'])).toThrow(TypeError);
    expect(() => createApiKeyPool([' '])).toThrow(TypeError);
    expect(createApiKeyPool([]).getState()).toEqual([]);
    const capped = createApiKeyPool(['a'], {maxOutstandingLeases: 1});
    capped.lease([], 0);
    expect(() => capped.lease([], 0)).toThrow(ApiKeyPoolExhaustedError);
  });

  it('supports network/server failures and custom recovery and initial weights', () => {
    const pool = createApiKeyPool(['a', 'b'], {initialWeight: 1, recoveryMs: 50});
    const first = pool.lease([], 0);
    pool.reportFailure(first, 'network', 0);
    expect(pool.getState(0)[0].weight).toBe(0);
    const second = pool.lease([], 0);
    pool.reportFailure(second, 'server', 0);
    expect(() => pool.lease([], 0)).toThrowError(/50/);
    expect(['a', 'b']).toContain(pool.lease([], 50).keyId);
  });

  it('classifies structured provider failures without treating public configuration errors as key faults', () => {
    expect(classifyApiKeyFailure({statusCode: 401})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'auth'})).toBe('cooldown');
    expect(classifyApiKeyFailure({statusCode: 403})).toBe('cooldown');
    expect(classifyApiKeyFailure({statusCode: 429})).toBe('cooldown');
    expect(classifyApiKeyFailure({code: 'invalid_api_key'})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'config', code: 'API_KEY_INVALID', statusCode: 400})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'config', code: 'invalidToken', statusCode: 400})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'config', message: 'API key not valid', statusCode: 400})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'config', message: 'API key expired', statusCode: 400})).toBe('cooldown');
    expect(classifyApiKeyFailure({kind: 'config', message: 'invalid max_tokens', statusCode: 400})).toBe('none');
    expect(classifyApiKeyFailure({kind: 'config', message: 'invalid token count', statusCode: 400})).toBe('none');
    expect(classifyApiKeyFailure({code: 'quota_exceeded'})).toBe('cooldown');
    expect(classifyApiKeyFailure({code: 'generate_error', statusCode: 500})).toBe('penalty');
    expect(classifyApiKeyFailure({kind: 'network', retryable: true})).toBe('penalty');
    expect(classifyApiKeyFailure({statusCode: 500})).toBe('penalty');
    expect(classifyApiKeyFailure({statusCode: 400})).toBe('none');
    expect(classifyApiKeyFailure({kind: 'config'})).toBe('none');
    expect(classifyApiKeyFailure({name: 'AbortError'})).toBe('none');
  });

  it('supports rotation scopes, direct key recovery, retry probing, and bounded scope eviction', () => {
    const rotation = createApiKeyRotation({maxScopes: 1});
    const first = rotation.pick('scope-a', ['a', 'b'], [], 0);
    expect(rotation.fail('scope-a', first, 'auth', 0)).toBe(true);
    expect(rotation.nextRetry('scope-a', ['a', 'b'], [], 0)).toBe(0);
    expect(rotation.success('scope-a', 'a', 1)).toBe(true);
    expect(rotation.pick('scope-a', ['a', 'b'], ['b'], 1).keyId).toBe('a');
    expect(rotation.success('unknown', 'a', 0)).toBe(false);
    expect(() => rotation.pick('', ['a'])).toThrow(TypeError);
    rotation.pick('scope-b', ['b'], [], 2);
    expect(rotation.nextRetry('scope-a', ['a'], [], 2)).toBe(0);
  });

  it('penalizes direct key reports and leaves non-penalizing reports unchanged', () => {
    const pool = createApiKeyPool(['a']);
    expect(pool.reportSuccessForKey('missing', 0)).toBe(false);
    expect(pool.reportFailureForKey('missing', 'auth', 0)).toBe(false);
    expect(pool.reportFailureForKey('a', 'auth', 0)).toBe(true);
    expect(pool.getState(0)[0].weight).toBe(0);
    expect(pool.reportFailureForKey('a', 'config', 0)).toBe(false);
    expect(pool.reportFailureForKey('a', 'transient', API_KEY_POOL_RECOVERY_MS)).toBe(true);
    expect(pool.getState(API_KEY_POOL_RECOVERY_MS)[0].weight).toBe(2);
  });

  it('keeps a newer failure stronger than an older in-flight success and syncs changing key lists', () => {
    const pool = createApiKeyPool(['a', 'b']);
    const oldLease = pool.lease([], 0);
    expect(pool.reportFailureForKey('a', 'auth', 1)).toBe(true);
    expect(pool.reportSuccess(oldLease, 2)).toBe(true);
    expect(pool.getState(2).find((item) => item.keyId === 'a')?.weight).toBe(0);
    pool.sync(['b', 'c']);
    expect(pool.getState(2).map((item) => item.keyId)).toEqual(['b', 'c']);
    expect(() => pool.sync(['c', 'c'])).toThrow(TypeError);
    const active = createApiKeyPool(['a']);
    active.lease([], 0);
    active.sync([]);
  });

  it('uses a configured rotation recovery window for retry hints', () => {
    const rotation = createApiKeyRotation({recoveryMs: 5});
    const lease = rotation.pick('custom', ['a'], [], 0);
    rotation.fail('custom', lease, 'auth', 0);
    expect(rotation.nextRetry('custom', ['a'], [], 0)).toBe(5);
    expect(createApiKeyRotation().nextRetry('empty', [], [], 0)).toBe(1);
  });

  it('keeps same-millisecond failures newer than an older lease success', () => {
    const pool = createApiKeyPool(['a']);
    const oldLease = pool.lease([], 100);
    expect(pool.reportFailureForKey('a', 'transient', 100)).toBe(true);
    expect(pool.reportFailureForKey('a', 'auth', 100)).toBe(true);
    expect(pool.reportSuccess(oldLease, 100)).toBe(true);
    expect(pool.getState(100)[0].weight).toBe(0);
  });

  it('honors valid Retry-After windows for cooldown failures and clamps unsafe values', () => {
    const pool = createApiKeyPool(['a', 'b']);
    const first = pool.lease([], 0);
    pool.reportFailure(first, 'rate-limit', 0, 250);
    expect(() => pool.lease(['b'], 500)).toThrowError(/500/);
    expect(() => pool.lease(['b'], 999)).toThrowError(/1,? ms/);
    const longWindow = createApiKeyPool(['only']);
    const second = longWindow.lease([], 1000);
    longWindow.reportFailure(second, 'auth', 1000, 2500);
    expect(() => longWindow.lease([], 2500)).toThrowError(/1000/);
    expect(longWindow.lease([], 3500).keyId).toBe('only');
    const invalid = createApiKeyPool(['a'], {recoveryMs: 25});
    const lease = invalid.lease([], 0);
    invalid.reportFailure(lease, 'rate-limit', 0, Number.NaN);
    expect(() => invalid.lease([], 24)).toThrow(ApiKeyPoolExhaustedError);
    expect(invalid.lease([], 25).keyId).toBe('a');
  });

  it('keeps old leases from applying to a recreated scope pool', () => {
    const rotation = createApiKeyRotation({maxScopes: 1});
    const oldLease = rotation.pick('old', ['a'], [], 0);
    rotation.pick('new', ['b'], [], 1);
    const newLease = rotation.pick('old', ['a'], [], 2);
    expect(rotation.success('old', oldLease, 2)).toBe(false);
    expect(rotation.success('old', newLease, 2)).toBe(true);
  });
  it('evicts the least recently touched scope and retains a newer lease even when insertion order differs', () => {
    const rotation = createApiKeyRotation({maxScopes: 2});
    const first = rotation.pick('first', ['a'], [], 0), oldest = rotation.pick('second', ['b'], [], 1);
    rotation.pick('first', ['a'], [], 2); rotation.pick('third', ['c'], [], 3);
    expect(rotation.success('second', oldest, 4)).toBe(false);
    expect(rotation.success('first', first, 4)).toBe(true);
  });

  it('reports lease results through rotation and returns cooldown retry time', () => {
    const rotation = createApiKeyRotation();
    const lease = rotation.pick('scope', ['a'], [], 0);
    expect(rotation.success('scope', lease, 0)).toBe(true);
    const failed = rotation.pick('scope', ['a'], [], 1);
    expect(rotation.fail('scope', failed, 'auth', 1)).toBe(true);
    expect(rotation.nextRetry('scope', ['a'], [], 1)).toBe(API_KEY_POOL_RECOVERY_MS);
    expect(rotation.fail('scope', 'unknown', 'auth', 1)).toBe(false);
    expect(rotation.fail('missing-scope', 'a', 'auth', 1)).toBe(false);
  });
});
