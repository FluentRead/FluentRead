import {describe, expect, it, vi} from 'vitest';
import {createFreeFallbackRunner, type FreeFallbackCandidate, type PersistedFreeHealth} from '@/src/services/translation/freeFallback';

const candidate = (identity: string, translate: FreeFallbackCandidate['translate'], extra: Partial<FreeFallbackCandidate> = {}): FreeFallbackCandidate => ({identity, label: identity, translate, ...extra});

describe('balanced free fallback routing', () => {
  it('starts with the first candidate and avoids repeating it on the next request', async () => {
    const calls: string[] = [];
    const runner = createFreeFallbackRunner(1, {random: () => 0});
    const candidates = ['microsoft', 'google', 'myMemory'].map(id => candidate(id, async () => { calls.push(id); return id; }));
    await expect(runner(candidates, {mode: 'balanced', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('microsoft');
    await expect(runner(candidates, {mode: 'balanced', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('google');
    expect(calls).toEqual(['microsoft', 'google']);
  });

  it('uses persisted performance in runner selection and keeps the healthy candidate favored', async () => {
    const calls = {a: 0, b: 0, c: 0};
    const persistence = {
      load: vi.fn(async () => [{identity: 'b', retryAt: 0, failures: 0, category: 'unavailable', performance: {reliability: 0.25, latencyMs: 10_000, observedAt: Date.now()}}]),
      save: vi.fn(async () => undefined),
    };
    const runner = createFreeFallbackRunner(1, {random: () => 0.4, persistence});
    const a = candidate('a', vi.fn(async () => { calls.a += 1; return 'a'; }), {weight: 3});
    const b = candidate('b', vi.fn(async () => { calls.b += 1; return 'b'; }), {weight: 3});
    const c = candidate('c', vi.fn(async () => { calls.c += 1; return 'c'; }), {weight: 3});
    await expect(runner([a, b, c], {mode: 'balanced', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('a');
    await expect(runner([a, b, c], {mode: 'balanced', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('c');
    expect(calls).toEqual({a: 1, b: 0, c: 1});
    expect(persistence.load).toHaveBeenCalledOnce();
    expect(persistence.save).toHaveBeenCalled();
  });

  it('falls back after a failure and respects per-candidate interval and concurrency', async () => {
    const starts: string[] = [];
    const runner = createFreeFallbackRunner(1, {random: () => 0});
    const failing = candidate('bad', async () => { starts.push('bad'); throw Object.assign(new Error('busy'), {status: 429}); }, {minIntervalMs: 50});
    const good = candidate('good', async () => { starts.push('good'); return 'ok'; });
    await expect(runner([failing, good], {mode: 'sequential', timeoutMs: 100, cooldownMs: 20})).resolves.toBe('ok');
    expect(starts).toEqual(['bad', 'good']);
    const times: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const limited = createFreeFallbackRunner(1);
    const slow = candidate('slow', async () => { times.push(Date.now()); await gate; return 'slow'; });
    const first = limited([slow], {mode: 'sequential', timeoutMs: 500, cooldownMs: 10});
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = limited([candidate('second', async () => { times.push(Date.now()); return 'second'; })], {mode: 'sequential', timeoutMs: 500, cooldownMs: 10});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(times).toHaveLength(1);
    release();
    await expect(first).resolves.toBe('slow');
    await expect(second).resolves.toBe('second');
    expect(times).toHaveLength(2);
  });

  it('keeps request errors local to one text while transient failures cool down in the health snapshot', async () => {
    const saved: PersistedFreeHealth[][] = [];
    const runner = createFreeFallbackRunner(1, {
      random: () => 0,
      persistence: {
        load: vi.fn(async () => []),
        save: vi.fn(async (entries: readonly PersistedFreeHealth[]) => { saved.push([...entries]); }),
      },
    });
    const requestCalls: string[] = [];
    const tooLong = candidate('too-long', async () => { requestCalls.push('too-long'); throw Object.assign(new Error('payload too large'), {status: 413}); });
    const good = candidate('good-request', async () => { requestCalls.push('good-request'); return 'ok'; });
    const options = {mode: 'sequential' as const, timeoutMs: 100, cooldownMs: 60_000};

    // 文本级 413 只让本段换服务：不暂停、不降权，下一段仍按用户顺序先试它。
    await expect(runner([tooLong, good], options)).resolves.toBe('ok');
    await expect(runner([tooLong, good], options)).resolves.toBe('ok');
    expect(requestCalls).toEqual(['too-long', 'good-request', 'too-long', 'good-request']);
    const afterRequestError = await runner.getHealthSnapshot();
    expect(afterRequestError.find(item => item.identity === 'too-long')).toBeUndefined();
    expect(saved.flat().some(item => item.identity === 'too-long')).toBe(false);

    const unavailable = candidate('unavailable', async () => { throw Object.assign(new Error('down'), {status: 503}); });
    await expect(runner([unavailable, good], options)).resolves.toBe('ok');
    const cooling = (await runner.getHealthSnapshot()).find(item => item.identity === 'unavailable');
    expect(cooling).toMatchObject({failures: 1, category: 'unavailable', performance: {reliability: 0.75}});
    expect(cooling?.retryAt).toBeGreaterThan(Date.now());
    expect(saved.at(-1)).toEqual(expect.arrayContaining([expect.objectContaining({identity: 'unavailable', category: 'unavailable'})]));
  });

  it('reports in-memory health without persistence and omits untouched providers', async () => {
    const legacy = {identity: 'legacy-cooling', retryAt: Date.now() + 100_000, failures: 1, category: 'blocked'};
    await expect(createFreeFallbackRunner(1, {persistence: {load: async () => [legacy], save: async () => undefined}})
      .getHealthSnapshot()).resolves.toEqual([legacy]);
    const runner = createFreeFallbackRunner(1, {random: () => 0});
    await expect(runner.getHealthSnapshot()).resolves.toEqual([]);
    const limited = candidate('limited', async () => { throw Object.assign(new Error('slow down'), {status: 429, retryAfterMs: 5_000}); });
    await expect(runner([limited, candidate('fallback', async () => 'ok')], {mode: 'sequential', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('ok');
    const snapshot = await runner.getHealthSnapshot();
    expect(snapshot.map(item => item.identity).sort()).toEqual(['fallback', 'limited']);
    expect(snapshot.find(item => item.identity === 'limited')).toMatchObject({failures: 1, category: 'rate-limit'});
    expect(snapshot.find(item => item.identity === 'limited')!.retryAt).toBeGreaterThanOrEqual(Date.now() + 4_900);
  });

  it('waits for the same candidate interval between sequential requests', async () => {
    const starts: number[] = [];
    const runner = createFreeFallbackRunner(1);
    const item = candidate('interval', async () => { starts.push(Date.now()); return 'ok'; }, {minIntervalMs: 30});
    await runner([item], {mode: 'sequential', timeoutMs: 200, cooldownMs: 10});
    const before = Date.now();
    await runner([item], {mode: 'sequential', timeoutMs: 200, cooldownMs: 10});
    expect(starts).toHaveLength(2);
    expect(starts[1]! - before).toBeGreaterThanOrEqual(20);
  });

  it('persists health, ignores invalid entries and recovers after a successful probe', async () => {
    const saved: PersistedFreeHealth[][] = [];
    const persistence = {load: vi.fn(async () => [
      {identity: 'bad', retryAt: 0, failures: 2, category: 'rate-limit'},
      {identity: 'legacy', retryAt: 0, failures: 0, category: 'unavailable'},
      {identity: 'bad space', retryAt: 0, failures: 1, category: 'quota'},
      {identity: 'bad2', retryAt: -1, failures: 1, category: 'blocked'},
    ]), save: vi.fn(async (entries: readonly PersistedFreeHealth[]) => { saved.push([...entries]); })};
    const runner = createFreeFallbackRunner(1, {random: () => 0, persistence});
    await expect(runner([candidate('bad', async () => 'bad'), candidate('good', async () => 'ok')], {mode: 'sequential', timeoutMs: 100, cooldownMs: 10})).resolves.toBe('bad');
    expect(persistence.load).toHaveBeenCalledTimes(1);
    expect(persistence.save).toHaveBeenCalled();
    expect(saved.at(-1)?.find(entry => entry.identity === 'bad')).toMatchObject({failures: 0, performance: {reliability: 1}});
  });

  it('loads non-array and malformed persisted health without blocking the first translation', async () => {
    const persistence = {load: vi.fn(async () => [null, 1, {}, {identity: 'bad space', retryAt: 0, failures: 1, category: 'quota'}, {identity: 'legacy', retryAt: 0, failures: 0, category: 'unavailable'}, {identity: 'invalid-performance', retryAt: 0, failures: 0, category: 'unavailable', performance: {reliability: 2, latencyMs: 0, observedAt: -1}}, {identity: 'good', retryAt: 0, failures: 1, category: 'bad'}]), save: vi.fn(async () => undefined)};
    const runner = createFreeFallbackRunner(1, {persistence});
    await expect(runner([candidate('good', async () => 'ok')], {timeoutMs: 50, cooldownMs: 10})).resolves.toBe('ok');
    const empty = createFreeFallbackRunner(1, {persistence: {load: vi.fn(async () => ({bad: true})), save: vi.fn(async () => undefined)}});
    await expect(empty([candidate('empty', async () => 'ok')], {timeoutMs: 50, cooldownMs: 10})).resolves.toBe('ok');
    const rejected = createFreeFallbackRunner(1, {persistence: {load: vi.fn(async () => { throw new Error('offline'); }), save: vi.fn(async () => undefined)}});
    await expect(rejected([candidate('rejected', async () => 'ok')], {timeoutMs: 50, cooldownMs: 10})).resolves.toBe('ok');
    const controller = new AbortController();
    const abortingLoad = createFreeFallbackRunner(1, {persistence: {load: vi.fn(async () => { controller.abort(); return []; }), save: vi.fn(async () => undefined)}});
    await expect(abortingLoad([candidate('aborting', async () => 'ok')], {timeoutMs: 50, cooldownMs: 10, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    const lateController = new AbortController();
    const delayedLoad = createFreeFallbackRunner(1, {persistence: {load: vi.fn(async () => { await Promise.resolve(); lateController.abort(); return []; }), save: vi.fn(async () => undefined)}});
    await expect(delayedLoad([candidate('delayed', async () => 'ok')], {timeoutMs: 50, cooldownMs: 10, signal: lateController.signal})).rejects.toMatchObject({name: 'AbortError'});
  });

  it('coalesces a hanging persistence save and still allows translation to finish', async () => {
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const persistence = {load: vi.fn(async () => []), save};
    const runner = createFreeFallbackRunner(2, {persistence});
    const bad = candidate('bad', vi.fn().mockRejectedValue(Object.assign(new Error('busy'), {status: 429})));
    const good = candidate('good', async () => 'ok');
    const request = runner([bad, good], {timeoutMs: 100, cooldownMs: 10});
    await expect(request).resolves.toBe('ok');
    expect(save).toHaveBeenCalledOnce();
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('cancels a hanging persistence save without leaving its abort listener behind', async () => {
    const save = vi.fn(() => new Promise<void>(() => undefined));
    const persistence = {load: vi.fn(async () => []), save};
    const runner = createFreeFallbackRunner(1, {persistence});
    const controller = new AbortController();
    const bad = candidate('bad-save', vi.fn().mockRejectedValue(Object.assign(new Error('busy'), {status: 429})));
    const pending = runner([bad], {timeoutMs: 500, cooldownMs: 10, signal: controller.signal});
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(Array.from({length: 20}, (_, index) => index + 1))('cancels after persistence load completion at microtask offset %i', async offset => {
    const controller = new AbortController();
    const persistence = {
      load: vi.fn(() => {
        let chain = Promise.resolve();
        for (let index = 0; index < offset; index += 1) chain = chain.then(() => undefined);
        chain.then(() => controller.abort());
        return Promise.resolve([]);
      }),
      save: vi.fn(async () => undefined),
    };
    const runner = createFreeFallbackRunner(1, {persistence});
    const provider = candidate('load-offset', vi.fn(async () => 'late'));
    await expect(runner([provider], {timeoutMs: 200, cooldownMs: 10, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
  });

  it('cancels while waiting for a cooled candidate to become available', async () => {
    const runner = createFreeFallbackRunner(1, {random: () => 0});
    const bad = candidate('bad', vi.fn().mockRejectedValue(Object.assign(new Error('busy'), {status: 429})));
    await expect(runner([bad], {timeoutMs: 100, cooldownMs: 50})).rejects.toThrow('HTTP 429');
    const controller = new AbortController();
    const pending = runner([bad], {timeoutMs: 1000, cooldownMs: 50, signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    const interval = createFreeFallbackRunner(1);
    await expect(interval([candidate('interval', async () => 'ok', {minIntervalMs: 100})], {timeoutMs: 500, cooldownMs: 10})).resolves.toBe('ok');
    const intervalController = new AbortController();
    const intervalPending = interval([candidate('interval', async () => 'ok', {minIntervalMs: 100})], {timeoutMs: 500, cooldownMs: 10, signal: intervalController.signal});
    await Promise.resolve();
    intervalController.abort();
    await expect(intervalPending).rejects.toMatchObject({name: 'AbortError'});
    const saturated = createFreeFallbackRunner(1);
    const saturatedController = new AbortController();
    const saturatedPending = saturated([candidate('saturated', async () => 'ok', {maxConcurrency: 0})], {timeoutMs: 500, cooldownMs: 10, signal: saturatedController.signal});
    await Promise.resolve();
    saturatedController.abort();
    await expect(saturatedPending).rejects.toMatchObject({name: 'AbortError'});
  });

  it('does not let a delayed persisted record overwrite a service that already succeeded', async () => {
    const load = vi.fn(() => new Promise(() => undefined));
    const runner = createFreeFallbackRunner(1, {persistence: {load, save: vi.fn(async () => undefined)}});
    const request = runner([candidate('live', async () => 'live')], {timeoutMs: 100, cooldownMs: 10});
    await expect(request).resolves.toBe('live');
    await expect(runner([candidate('live', async () => 'live-again')], {timeoutMs: 100, cooldownMs: 10})).resolves.toBe('live-again');
  });

  it('continues when saving a newly recorded failure rejects', async () => {
    const persistence = {load: vi.fn(async () => []), save: vi.fn(async () => { throw new Error('storage offline'); })};
    const runner = createFreeFallbackRunner(1, {persistence});
    const bad = candidate('save-failure', async () => { throw Object.assign(new Error('busy'), {status: 429}); });
    await expect(runner([bad], {timeoutMs: 100, cooldownMs: 10})).rejects.toThrow('HTTP 429');
    expect(persistence.save).toHaveBeenCalledOnce();
  });

  it('cancels after a recovered unhealthy probe has persisted its reset', async () => {
    const controller = new AbortController();
    const persistence = {
      load: vi.fn(async () => [{identity: 'recovering', retryAt: 0, failures: 1, category: 'rate-limit', performance: {reliability: 0.5, latencyMs: 1000, observedAt: Date.now()}}]),
      save: vi.fn(async () => { queueMicrotask(() => controller.abort()); }),
    };
    const runner = createFreeFallbackRunner(1, {persistence});
    const recovering = candidate('recovering', vi.fn().mockResolvedValue('recovered'));
    await expect(runner([recovering], {timeoutMs: 100, cooldownMs: 10, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(recovering.translate).toHaveBeenCalledOnce();
  });

  it.each([1, 7, 8, 9])('cancels after persistence save completion at microtask offset %i', async offset => {
    const controller = new AbortController();
    const persistence = {
      load: vi.fn(async () => [{identity: 'recover-offset', retryAt: 0, failures: 1, category: 'rate-limit', performance: {reliability: 0.5, latencyMs: 1000, observedAt: Date.now()}}]),
      save: vi.fn(() => {
        let resolveSave!: () => void;
        const result = new Promise<void>(resolve => { resolveSave = resolve; });
        resolveSave();
        let chain = Promise.resolve();
        for (let index = 0; index < offset; index += 1) chain = chain.then(() => undefined);
        chain.then(() => controller.abort());
        return result;
      }),
    };
    const runner = createFreeFallbackRunner(1, {persistence});
    const provider = candidate('recover-offset', vi.fn(async () => 'recovered'));
    await expect(runner([provider], {timeoutMs: 200, cooldownMs: 10, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    expect(provider.translate).toHaveBeenCalledOnce();
  });


  it('preserves a cooling legacy record without performance while persisting a successful service', async () => {
    const legacy = {identity: 'old', retryAt: Date.now() + 100_000, failures: 1, category: 'blocked'};
    const save = vi.fn(async () => undefined);
    const runner = createFreeFallbackRunner(1, {persistence: {load: async () => [legacy], save}});
    await expect(runner([candidate('new', async () => 'ok')], {timeoutMs: 100, cooldownMs: 100})).resolves.toBe('ok');
    expect(save).toHaveBeenCalledWith(expect.arrayContaining([legacy]));
  });

  it('does not let persistence failures block translation', async () => {
    const runner = createFreeFallbackRunner(1, {persistence: {load: async () => { throw new Error('offline'); }, save: async () => { throw new Error('offline'); }}});
    await expect(runner([candidate('ok', async () => '译文')], {timeoutMs: 100, cooldownMs: 10})).resolves.toBe('译文');
  });

  it('aborts waiting and enforces the total deadline', async () => {
    const controller = new AbortController();
    const runner = createFreeFallbackRunner(1);
    const pending = runner([candidate('slow', signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancel'), {name: 'AbortError'})))))], {timeoutMs: 10_000, cooldownMs: 10_000, signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(runner([candidate('slow', async () => new Promise(() => undefined))], {timeoutMs: 1, cooldownMs: 1, deadline: Date.now()})).rejects.toThrow('请求超时');
  });

  it('handles empty, pre-aborted, blank, timeout, and all-cooling requests', async () => {
    const runner = createFreeFallbackRunner(1);
    await expect(runner([], {timeoutMs: 10, cooldownMs: 10})).rejects.toThrow('未选择可用');
    const controller = new AbortController(); controller.abort();
    await expect(runner([candidate('x', async () => 'x')], {timeoutMs: 10, cooldownMs: 10, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
    await expect(runner([candidate('blank', async () => '  '), candidate('ok', async () => 'ok')], {timeoutMs: 20, cooldownMs: 10})).resolves.toBe('ok');
    await expect(runner([candidate('timeout', async signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))], {timeoutMs: 1, cooldownMs: 1})).rejects.toThrow('均不可用');
    const cooldown = createFreeFallbackRunner(1);
    await expect(cooldown([candidate('bad', async () => { throw Object.assign(new Error('blocked'), {status: 403}); })], {timeoutMs: 20, cooldownMs: 1})).rejects.toThrow('均不可用');
  });

  it('cancels a queued request while another request holds the runner', async () => {
    const runner = createFreeFallbackRunner(1);
    let release!: () => void;
    const hold = runner([candidate('hold', async () => new Promise(resolve => { release = () => resolve('held'); }))], {timeoutMs: 500, cooldownMs: 10});
    await new Promise(resolve => setTimeout(resolve, 1));
    const controller = new AbortController();
    const queued = runner([candidate('queued', async () => 'queued')], {timeoutMs: 500, cooldownMs: 10, signal: controller.signal});
    controller.abort();
    await expect(queued).rejects.toMatchObject({name: 'AbortError'});
    release();
    await expect(hold).resolves.toBe('held');
  });
});
