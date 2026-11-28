import {describe, expect, it, vi} from 'vitest';
import {VideoTranslationCache} from '@/src/features/video-subtitle/content/translationCache';

describe('VideoTranslationCache', () => {
  it('重复预取共享请求，供应商结算与清空交错时不复活缓存', async () => {
    let complete!: (value: string) => void;
    const translate = vi.fn(() => new Promise<string>(resolve => {complete = resolve;}));
    const cache = new VideoTranslationCache(translate), first = cache.request('same', true);
    expect(cache.request('same', true)).toBe(first); await Promise.resolve(); complete('译文'); await expect(first).resolves.toBe('译文');
    expect(translate).toHaveBeenCalledOnce();
    for (let delay = 0; delay <= 16; delay++) {
      const current = new VideoTranslationCache(async () => 'ready result');
      const settled = current.request('source').then(value => ({value}), error => ({error}));
      const cleared = (async () => {for (let step = 0; step < delay; step++) await Promise.resolve(); current.clear();})();
      await Promise.all([settled, cleared]); expect(current.peek('source')).toBeUndefined();
    }
  });
  it('按当前播放窗口预取，当前句优先，单句失败不会中断其他预取', async () => {
    const cache = new VideoTranslationCache(async () => 'ok');
    const current = {startMs: 0, durationMs: 1000, text: 'Current'};
    const next = {startMs: 2000, durationMs: 1000, text: 'Next'};
    const request = vi.fn(async (source: string) => {if (source === 'Current') throw new Error('offline'); return 'ok';});
    cache.primeUpcoming([next, current], 500, 10_000, 1, request);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(request.mock.calls).toEqual([['Current', false, current], ['Next', true, next]]);
    cache.primeUpcoming([next], NaN, 10_000, 1, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('长时间轴在边界之间不重扫，当前句仍能按原优先级检查请求', () => {
    let timingReads = 0;
    const cues = Array.from({length: 4000}, (_, index) => ({
      get startMs() { timingReads += 1; return index * 3000; },
      durationMs: 2500,
      text: `Cue ${index}`,
    }));
    const cache = new VideoTranslationCache(async () => 'ok');
    const request = vi.fn(async () => 'ok');
    cache.primeUpcoming(cues, 500, 600, 1, request);
    expect(timingReads).toBeGreaterThanOrEqual(cues.length);
    const afterFirstSelection = timingReads;

    for (let currentMs = 620; currentMs <= 2180; currentMs += 120) {
      cache.primeUpcoming(cues, currentMs, 600, 1, request);
    }
    expect(request).toHaveBeenCalledTimes(15);
    // primeUpcoming 每次只读被选中 cue 的起点以保持当前/预取优先级。
    expect(timingReads - afterFirstSelection).toBe(14);
    expect(request).toHaveBeenLastCalledWith('Cue 0', false, cues[0]);

    cache.primeUpcoming(cues, 2400, 600, 1, request);
    expect(request).toHaveBeenLastCalledWith('Cue 1', true, cues[1]);
    cache.clear();
    const afterClear = timingReads;
    cache.primeUpcoming(cues, 2400, 600, 1, request);
    expect(timingReads - afterClear).toBeGreaterThanOrEqual(cues.length);
  });

  it('同步读取规范化后的成功译文，不重复请求，并随 clear 清理', async () => {
    const translate = vi.fn(async () => '同步译文');
    const cache = new VideoTranslationCache(translate);
    expect(cache.peek('Hello world')).toBeUndefined();
    expect(cache.revision).toBe(0);
    await cache.request(' Hello   world ', true);
    expect(cache.peek('Hello\nworld')).toBe('同步译文');
    expect(cache.revision).toBe(1);
    cache.cancelPending();
    expect(cache.peek(' Hello world ')).toBe('同步译文');
    expect(cache.revision).toBe(1);
    expect(translate).toHaveBeenCalledOnce();
    cache.clear();
    expect(cache.peek('Hello world')).toBeUndefined();
    expect(cache.revision).toBe(2);
  });

  it('取消过期预取不算失败，同文回到窗口后可以立即重新请求', async () => {
    const calls: string[] = [];
    const releases = new Map<string, (value: string) => void>();
    const cache = new VideoTranslationCache(text => new Promise(resolve => {calls.push(text); releases.set(text, resolve);}));
    const a = cache.request('active-a', true); const b = cache.request('active-b', true);
    const obsolete = cache.request('obsolete', true);
    const obsoleteResult = expect(obsolete).rejects.toMatchObject({name: 'AbortError'});
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    cache.retainPrefetches(['active-a', ' active-b ']);
    const returned = cache.request(' obsolete ', true);
    await obsoleteResult;
    expect(cache.hasFailure('obsolete')).toBe(false);
    releases.get('active-a')!('A'); releases.get('active-b')!('B');
    await Promise.all([a, b]);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual(['active-a', 'active-b', 'obsolete']);
    releases.get('obsolete')!('O');
    await expect(returned).resolves.toBe('O');
    expect(cache.peek('obsolete')).toBe('O');
  });

  it('规范化 key、合并请求、缓存结果且不把空译文当成成功', async () => {
    const translate = vi.fn(async (text: string) => text === 'empty' ? '' : `译-${text}`);
    const cache = new VideoTranslationCache(translate);
    await expect(cache.request('  hello   world ')).resolves.toBe('译-hello world');
    await expect(cache.request('hello world')).resolves.toBe('译-hello world');
    await expect(cache.request('empty')).rejects.toThrow('空内容');
    await expect(cache.request('empty')).resolves.toBe('');
    expect(cache.hasFailure(' empty ')).toBe(true);
    expect(translate).toHaveBeenCalledTimes(2);
  });
  it('手动重试失败句，保留成功缓存并合并重复点击', async () => {
    let fail = true;
    const translate = vi.fn(async (text: string) => {
      if (text === 'failed' && fail) throw new Error('offline');
      return `译-${text}`;
    });
    const cache = new VideoTranslationCache(translate);
    await cache.request('success');
    await expect(cache.request('failed')).rejects.toThrow('offline');
    expect(cache.hasFailure('failed')).toBe(true);
    fail = false;
    cache.retryFailures();
    await expect(Promise.all([cache.request('failed'), cache.request('failed')])).resolves.toEqual(['译-failed', '译-failed']);
    await expect(cache.request('success')).resolves.toBe('译-success');
    expect(cache.hasFailure('failed')).toBe(false);
    expect(translate).toHaveBeenCalledTimes(3);
  });
  it('隐藏译文时取消在途请求，但重新显示可复用已完成译文', async () => {
    const translate = vi.fn((text: string) => text === 'saved' ? Promise.resolve('已缓存') : new Promise<string>(() => undefined));
    const cache = new VideoTranslationCache(translate);
    await cache.request('saved');
    const pending = cache.request('pending');
    cache.cancelPending();
    await expect(pending).rejects.toThrow('切换');
    await expect(cache.request('saved')).resolves.toBe('已缓存');
    expect(translate.mock.calls.filter(([text]) => text === 'saved')).toHaveLength(1);
  });
  it('clear 后迟到结果不写回，失败进入退避', async () => {
    let resolve!: (value: string) => void;
    const cache = new VideoTranslationCache(() => new Promise<string>(r => { resolve = r; }));
    const old = cache.request('old'); await new Promise<void>(r => setTimeout(r, 0)); cache.clear(); resolve('late'); await expect(old).rejects.toBeTruthy();
    const failing = new VideoTranslationCache(async () => { throw new Error('failed'); });
    await expect(failing.request('fresh')).rejects.toThrow('failed');
    await expect(failing.request('fresh')).resolves.toBe('');
  });

  it('退避结束后重试同一 key 会累加失败次数', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const cache = new VideoTranslationCache(async () => { throw new Error('failed'); });
    await expect(cache.request('retry')).rejects.toThrow('failed');
    now.mockReturnValue(4_000);
    await expect(cache.request('retry')).rejects.toThrow('failed');
    await expect(cache.request('retry')).resolves.toBe('');
    now.mockRestore();
  });
  it('合并同 key 的在途请求，并允许当前请求提升预取优先级', async () => {
    let resolve!: (value: string) => void;
    const translate = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const cache = new VideoTranslationCache(translate);
    const first = cache.request('same', true);
    const second = cache.request(' same ');
    await new Promise<void>(r => setTimeout(r, 0));
    resolve('translated');
    await expect(Promise.all([first, second])).resolves.toEqual(['translated', 'translated']);
    expect(translate).toHaveBeenCalledOnce();
  });
  it('成功和失败缓存都限制在 160 条以内', async () => {
    const success = new VideoTranslationCache(async text => `ok-${text}`);
    for (let i = 0; i < 161; i += 1) await success.request(`success-${i}`);
    const fail = new VideoTranslationCache(async () => { throw new Error('no'); });
    for (let i = 0; i < 161; i += 1) await fail.request(`failure-${i}`).catch(() => undefined);
    await expect(fail.request('failure-0')).rejects.toThrow('no');
  });
  it('空 key 不请求，非字符串 provider 结果进入失败退避', async () => {
    const cache = new VideoTranslationCache(async () => 1 as unknown as string);
    await expect(cache.request('   ')).resolves.toBe('   ');
    await expect(cache.request('non-string')).rejects.toThrow('空内容');
  });

  it('成功缓存采用 LRU 淘汰，peek 和 request 命中都会刷新活跃度', async () => {
    const translate = vi.fn(async (text: string) => `译-${text}`);
    const cache = new VideoTranslationCache(translate);
    for (let i = 0; i < 160; i += 1) await cache.request(`item-${i}`);
    // 刷新 item-0（经 peek）与 item-1（经 request），则 item-2 成为最久未用。
    expect(cache.peek('item-0')).toBe('译-item-0');
    await expect(cache.request('item-1')).resolves.toBe('译-item-1');
    await cache.request('item-160');
    expect(cache.peek('item-0')).toBe('译-item-0');
    expect(cache.peek('item-1')).toBe('译-item-1');
    expect(cache.peek('item-2')).toBeUndefined();
    expect(cache.peek('item-160')).toBe('译-item-160');
  });

  it('429 限流触发共享冷却与单探针恢复，并暴露只读失败状态', async () => {
    let clock = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      let probeResolve!: (value: string) => void;
      let mode: 'rate-limit' | 'rate-limit-again' | 'hold' | 'transient' | 'ok' = 'rate-limit';
      const translate = vi.fn((text: string) => {
        if (mode === 'rate-limit') {
          return Promise.reject(Object.assign(new Error('Too many requests'), {statusCode: 429, retryAfterMs: 12_000}));
        }
        if (mode === 'rate-limit-again') {
          return Promise.reject(Object.assign(new Error('Still limited'), {kind: 'rate-limit'}));
        }
        if (mode === 'transient') {
          return Promise.reject(new Error('Temporary network issue'));
        }
        if (mode === 'hold') {
          return new Promise<string>(resolve => { probeResolve = resolve; });
        }
        return Promise.resolve(`译-${text}`);
      });
      const cache = new VideoTranslationCache(translate, {random: () => 0});
      expect(cache.getFailureStatus()).toEqual({state: 'ok', retryAt: 0, message: ''});

      await expect(cache.request('cue-1')).rejects.toThrow('Too many requests');
      expect(cache.getFailureStatus()).toEqual({
        state: 'cooldown',
        retryAt: 22_000,
        message: 'Too many requests',
      });
      // 冷却期内抑制新预取和当前句请求。
      await expect(cache.request('cue-2', true)).resolves.toBe('');
      await expect(cache.request('cue-3', false)).resolves.toBe('');
      expect(translate).toHaveBeenCalledTimes(1);

      // 冷却到期后仅放行单个探针，探针在途期间其他新 key 继续返回空串。
      clock = 22_000;
      mode = 'hold';
      const probe = cache.request('cue-probe');
      await expect(cache.request('cue-blocked', true)).resolves.toBe('');
      expect(translate).toHaveBeenCalledTimes(2);
      probeResolve('译-cue-probe');
      await expect(probe).resolves.toBe('译-cue-probe');

      // 探针成功后清理共享冷却，普通请求恢复；之前失败的 cue-1 仍在失败表内故状态为 retrying。
      expect(cache.getFailureStatus().state).toBe('retrying');
      mode = 'ok';
      await expect(cache.request('cue-1')).resolves.toBe('译-cue-1');
      expect(cache.getFailureStatus()).toEqual({state: 'ok', retryAt: 0, message: ''});

      // 探针遇到瞬态错误时退出共享冷却，交由单句退避。
      mode = 'rate-limit-again';
      await expect(cache.request('cue-rl')).rejects.toThrow('Still limited');
      expect(cache.getFailureStatus().state).toBe('cooldown');
      clock += 6_000;
      mode = 'transient';
      await expect(cache.request('cue-rl-probe')).rejects.toThrow('Temporary network issue');
      expect(cache.getFailureStatus().state).toBe('retrying');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('永久错误进入供应商级熔断阻止预取风暴，并可通过 retryFailures 或 clear 恢复', async () => {
    let broken = true;
    const translate = vi.fn(async (text: string) => {
      if (broken) {
        throw Object.assign(new Error('Invalid API key'), {kind: 'authentication', statusCode: 401});
      }
      return `译-${text}`;
    });
    const cache = new VideoTranslationCache(translate, {random: () => 0});
    await expect(cache.request('first')).rejects.toThrow('Invalid API key');
    expect(cache.getFailureStatus()).toEqual({
      state: 'permanent',
      retryAt: Infinity,
      message: 'Invalid API key',
    });
    await expect(cache.request('second', true)).resolves.toBe('');
    await expect(cache.request('third', false)).resolves.toBe('');
    expect(translate).toHaveBeenCalledTimes(1);

    broken = false;
    cache.retryFailures();
    expect(cache.getFailureStatus()).toEqual({state: 'ok', retryAt: 0, message: ''});
    await expect(cache.request('first')).resolves.toBe('译-first');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('getFailureStatus 返回多句失败中最早的 retryAt，支持 abortPrefetchesNotIn 抢占并优化 primeUpcoming 重复调用', async () => {
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const releases = new Map<string, (value: string) => void>();
      const signals = new Map<string, AbortSignal>();
      const translate = vi.fn((text: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
        signals.set(text, signal);
        if (text.startsWith('fail-')) {
          reject(new Error(`err-${text}`));
          return;
        }
        releases.set(text, resolve);
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const cache = new VideoTranslationCache(translate, {random: () => 0});

      await expect(cache.request('fail-late')).rejects.toThrow('err-fail-late');
      clock = 1_500;
      await expect(cache.request('fail-later')).rejects.toThrow('err-fail-later');
      // fail-late 的 retryAt (3_000) 早于 fail-later (3_500)。
      expect(cache.getFailureStatus()).toEqual({
        state: 'retrying',
        retryAt: 3_000,
        message: 'err-fail-later',
      });
      cache.retryFailures();

      // abortPrefetchesNotIn 清理未启动在途并向已启动预取发 abort，不计为失败。
      const p1 = cache.request('active-1', true);
      const p2 = cache.request('active-2', true);
      const p3 = cache.request('queued-drop', true);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      cache.abortPrefetchesNotIn(['active-1']);
      await expect(p3).rejects.toMatchObject({name: 'AbortError'});
      await expect(p2).rejects.toMatchObject({name: 'AbortError'});
      expect(signals.get('active-2')?.aborted).toBe(true);
      expect(cache.hasFailure('active-2')).toBe(false);
      expect(cache.hasFailure('queued-drop')).toBe(false);
      releases.get('active-1')!('译-active-1');
      await expect(p1).resolves.toBe('译-active-1');

      // primeUpcoming 对已缓存或已在途的预取跳过重复回调，空选区也安全清理。
      const cues = [
        {startMs: 0, durationMs: 2000, text: 'active-1'},
        {startMs: 3000, durationMs: 2000, text: 'upcoming-1'},
      ];
      const callback = vi.fn((source: string, prefetch: boolean) => cache.request(source, prefetch));
      cache.primeUpcoming(cues, 500, 5_000, 1, callback);
      // active-1 已缓存跳过，仅请求 upcoming-1。
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('upcoming-1', true, cues[1]);
      // 同一窗口再次 primeUpcoming 时，upcoming-1 已在途预取，不再重复触发 callback。
      cache.primeUpcoming(cues, 600, 5_000, 1, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      // 跳到无效时间返回空选区，不抛出异常并清理未启动预取。
      cache.primeUpcoming(cues, NaN, 5_000, 1, callback);
      cache.cancelPending();

      // 提升在途预取后底层失败时，内部提升分支的拒绝被安全吸收。
      const rejectCache = new VideoTranslationCache(async () => { throw new Error('promoted fail'); });
      const firstPrefetch = rejectCache.request('boom', true);
      const promoted = rejectCache.request('boom', false);
      expect(promoted).toBe(firstPrefetch);
      await expect(firstPrefetch).rejects.toThrow('promoted fail');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('并发 429 不叠加退避次数或缩短 Retry-After，探针按身份隔离且永久失败不被覆盖，跳转回退不复用已中止在途请求', async () => {
    let clock = 10_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      // 1. 并发 429 突发：先到的长 Retry-After 不被后到的短 429 缩短，且 rateLimitAttempts 不重复递增。
      const rejectors = new Map<string, (err: unknown) => void>();
      const resolvers = new Map<string, (val: string) => void>();
      const burstTranslate = vi.fn((text: string) => new Promise<string>((resolve, reject) => {
        resolvers.set(text, resolve);
        rejectors.set(text, reject);
      }));
      const burstCache = new VideoTranslationCache(burstTranslate, {random: () => 0});
      const b1 = burstCache.request('burst-1', true);
      const b2 = burstCache.request('burst-2', true);
      await new Promise<void>(r => setTimeout(r, 0));

      rejectors.get('burst-1')!(Object.assign(new Error('429 long'), {statusCode: 429, retryAfterMs: 30_000}));
      await expect(b1).rejects.toThrow('429 long');
      expect(burstCache.getFailureStatus()).toEqual({state: 'cooldown', retryAt: 40_000, message: '429 long'});

      // 兄弟 429 到达时仍在冷却期内：不得缩短 sharedCooldownUntil，也不得额外递增 rateLimitAttempts。
      rejectors.get('burst-2')!(Object.assign(new Error('429 short'), {statusCode: 429}));
      await expect(b2).rejects.toThrow('429 short');
      expect(burstCache.getFailureStatus()).toEqual({state: 'cooldown', retryAt: 40_000, message: '429 short'});

      // 冷却到期后探针再遇 429：rateLimitAttempts 仅从 1 增至 2（15_000ms 而非 30_000ms）。
      clock = 40_000;
      const probeFail = burstCache.request('burst-probe');
      await new Promise<void>(r => setTimeout(r, 0));
      rejectors.get('burst-probe')!(Object.assign(new Error('429 probe'), {statusCode: 429}));
      await expect(probeFail).rejects.toThrow('429 probe');
      expect(burstCache.getFailureStatus().retryAt).toBe(55_000);

      // 2. retryFailures() 后旧探针迟到结算不得清空新探针或新冷却。
      clock = 55_000;
      const oldProbe = burstCache.request('old-probe');
      await new Promise<void>(r => setTimeout(r, 0));
      burstCache.retryFailures();
      const newRl = burstCache.request('new-rl');
      await new Promise<void>(r => setTimeout(r, 0));
      rejectors.get('new-rl')!(Object.assign(new Error('429 fresh'), {statusCode: 429}));
      await expect(newRl).rejects.toThrow('429 fresh');
      clock = 60_000;
      const newProbe = burstCache.request('new-probe');
      await new Promise<void>(r => setTimeout(r, 0));
      // 旧探针遇到瞬态错误迟到结算：既不清空新冷却，也不清空新 activeProbe。
      rejectors.get('old-probe')!(new Error('stale transient'));
      await expect(oldProbe).rejects.toThrow('stale transient');
      await expect(burstCache.request('blocked-by-new-probe', true)).resolves.toBe('');
      resolvers.get('new-probe')!('译-new-probe');
      await expect(newProbe).resolves.toBe('译-new-probe');

      // 3. 永久失败后，兄弟在途的瞬态/限流拒绝不得覆盖 lastFailureMessage 或 sharedCooldownUntil。
      const permRejectors = new Map<string, (err: unknown) => void>();
      const permCache = new VideoTranslationCache((text: string) => new Promise<string>((_r, reject) => {
        permRejectors.set(text, reject);
      }), {random: () => 0});
      const pAuth = permCache.request('perm-auth', true);
      const pSibling = permCache.request('perm-sibling', true);
      await new Promise<void>(r => setTimeout(r, 0));
      permRejectors.get('perm-auth')!(Object.assign(new Error('Invalid API key'), {kind: 'authentication', statusCode: 401}));
      await expect(pAuth).rejects.toThrow('Invalid API key');
      permRejectors.get('perm-sibling')!(Object.assign(new Error('Sibling 429'), {statusCode: 429, retryAfterMs: 5_000}));
      await expect(pSibling).rejects.toThrow('Sibling 429');
      expect(permCache.getFailureStatus()).toEqual({
        state: 'permanent',
        retryAt: Infinity,
        message: 'Invalid API key',
      });

      // 4. abortPrefetchesNotIn 后立即回跳到同一句，不复用即将被中止的旧 promise。
      const calls: Array<{text: string; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void}> = [];
      const seekCache = new VideoTranslationCache((text, signal) => new Promise<string>((resolve, reject) => {
        calls.push({text, signal, resolve, reject});
      }));
      const doomed = seekCache.request('seek-cue', true);
      await new Promise<void>(r => setTimeout(r, 0));
      expect(calls).toHaveLength(1);
      seekCache.abortPrefetchesNotIn([]);
      expect(calls[0]!.signal.aborted).toBe(true);
      // 在旧 transport 结算前立即重新请求同一句：获得全新 promise，并在旧 transport 结算后正常启动返回。
      const fresh = seekCache.request('seek-cue', false);
      expect(fresh).not.toBe(doomed);
      calls[0]!.reject(new Error('old aborted'));
      await expect(doomed).rejects.toMatchObject({name: 'AbortError'});
      await new Promise<void>(r => setTimeout(r, 0));
      expect(calls).toHaveLength(2);
      expect(calls[1]!.signal.aborted).toBe(false);
      calls[1]!.resolve('译-seek-cue');
      await expect(fresh).resolves.toBe('译-seek-cue');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
