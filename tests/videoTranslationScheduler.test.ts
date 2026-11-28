import {describe, expect, it, vi} from 'vitest';
import {VideoTranslationScheduler} from '@/src/features/video-subtitle/content/translationScheduler';

const tick = () => new Promise<void>(r => setTimeout(r, 0));
describe('VideoTranslationScheduler', () => {
  it('重复预取复用原任务，不占用额外名额', async () => {
    let complete!: (value: string) => void;
    const translate = vi.fn(() => new Promise<string>(resolve => {complete = resolve;}));
    const scheduler = new VideoTranslationScheduler(translate), first = scheduler.request('same', true);
    expect(scheduler.request('same', true)).toBe(first); await tick(); expect(translate).toHaveBeenCalledOnce();
    complete('译文'); await expect(first).resolves.toBe('译文');
  });
  it('跳转后删除旧的未启动预取，保留在途、当前优先请求和新窗口', async () => {
    const calls: string[] = [];
    const releases = new Map<string, (text: string) => void>();
    const scheduler = new VideoTranslationScheduler(source => new Promise(resolve => {calls.push(source); releases.set(source, resolve);}));
    const jobs = [scheduler.request('active-a', true), scheduler.request('active-b', true), scheduler.request('obsolete', true), scheduler.request('promoted', true), scheduler.request('upcoming', true)];
    const settled = Promise.allSettled(jobs);
    const promoted = scheduler.request('promoted');
    await tick();
    expect(calls).toEqual(['active-a', 'active-b', 'promoted']);
    expect(scheduler.retainPrefetches(new Set(['upcoming']))).toEqual(['obsolete']);
    releases.get('active-a')!('A'); releases.get('active-b')!('B'); releases.get('promoted')!('P');
    await tick();
    expect(calls).toEqual(['active-a', 'active-b', 'promoted', 'upcoming']);
    releases.get('upcoming')!('U');
    expect(await settled).toEqual([
      {status: 'fulfilled', value: 'A'}, {status: 'fulfilled', value: 'B'},
      {status: 'rejected', reason: expect.objectContaining({name: 'AbortError'})},
      {status: 'fulfilled', value: 'P'}, {status: 'fulfilled', value: 'U'},
    ]);
    await expect(promoted).resolves.toBe('P');
    expect(scheduler.retainPrefetches(new Set())).toEqual([]);
  });

  it('合并重复请求并提升 current lane 优先级', async () => {
    const calls: string[] = [];
    const scheduler = new VideoTranslationScheduler(async source => { calls.push(source); return source.toUpperCase(); });
    const a = scheduler.request('a', true); const b = scheduler.request('b', true); const a2 = scheduler.request('a');
    await expect(Promise.all([a, a2, b])).resolves.toEqual(['A', 'A', 'B']);
    expect(calls).toEqual(['a', 'b']);
  });
  it('clear 会 abort、拒绝旧 promise，并允许新一轮请求', async () => {
    let resolve!: (value: string) => void;
    const scheduler = new VideoTranslationScheduler((_s, signal) => new Promise<string>((r, reject) => { resolve = r; signal.addEventListener('abort', () => reject(new Error('aborted'))); }));
    const old = scheduler.request('old'); await tick(); scheduler.clear();
    await expect(old).rejects.toMatchObject({name: 'AbortError'});
    const next = scheduler.request('new');
    await tick();
    resolve('new-value');
    await tick();
    await expect(next).resolves.toBe('new-value');
  });
  it('预取最多占两路，第三路等待；已取消任务不会调用 translate', async () => {
    let calls = 0;
    const scheduler = new VideoTranslationScheduler(async () => { calls += 1; return 'ok'; });
    const waiting = [scheduler.request('a', true), scheduler.request('b', true), scheduler.request('c', true)];
    scheduler.clear();
    await Promise.allSettled(waiting);
    expect(calls).toBeLessThanOrEqual(2);
    const cancelled = scheduler.request('cancel');
    scheduler.clear();
    await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
  });

  it('满载重复提升不枚举任务，释放后保留当前优先级与同级顺序', async () => {
    const calls: string[] = [];
    const releases = new Map<string, (text: string) => void>();
    const requests: Promise<string>[] = [];
    const scheduler = new VideoTranslationScheduler(source => new Promise(resolve => {
      calls.push(source);
      releases.set(source, resolve);
    }));
    const observe = (request: Promise<string>) => {
      requests.push(request);
      void request.catch(() => undefined);
      return request;
    };
    let restoreValuesSpy: (() => void) | undefined;
    try {
      observe(scheduler.request('active-a', true));
      observe(scheduler.request('active-b', true));
      observe(scheduler.request('active-current'));
      observe(scheduler.request('queued-first', true));
      const promoted = observe(scheduler.request('queued-promoted', true));
      observe(scheduler.request('queued-last', true));
      await tick();
      expect(calls).toEqual(['active-a', 'active-b', 'active-current']);

      // 同步窗口只调用真实 scheduler.request；断言和异步清理均在恢复原生 Map 方法后执行。
      const valuesSpy = vi.spyOn(Map.prototype, 'values');
      restoreValuesSpy = () => valuesSpy.mockRestore();
      let samePromise = true;
      let enumerationCalls: number;
      try {
        for (let index = 0; index < 100; index += 1) {
          const repeated = scheduler.request('queued-promoted');
          samePromise = repeated === promoted && samePromise;
        }
        enumerationCalls = valuesSpy.mock.calls.length;
      } finally {
        valuesSpy.mockRestore();
        restoreValuesSpy = undefined;
      }
      expect(samePromise).toBe(true);
      observe(scheduler.request('queued-current-later'));
      await tick();
      expect(calls).toEqual(['active-a', 'active-b', 'active-current']);

      releases.get('active-a')!('A');
      await tick();
      expect(calls).toEqual(['active-a', 'active-b', 'active-current', 'queued-promoted']);
      releases.get('active-b')!('B');
      await tick();
      expect(calls.at(-1)).toBe('queued-current-later');
      releases.get('active-current')!('C');
      await tick();
      expect(calls).toHaveLength(5);
      releases.get('queued-promoted')!('P');
      await tick();
      expect(calls.at(-1)).toBe('queued-first');
      releases.get('queued-current-later')!('L');
      await tick();
      expect(calls.at(-1)).toBe('queued-last');
      releases.get('queued-first')!('F');
      releases.get('queued-last')!('Q');
      await expect(Promise.all(requests)).resolves.toEqual(['A', 'B', 'C', 'F', 'P', 'Q', 'L']);
      expect(calls).toEqual(['active-a', 'active-b', 'active-current', 'queued-promoted', 'queued-current-later', 'queued-first', 'queued-last']);
      expect(enumerationCalls).toBe(0);
    } finally {
      restoreValuesSpy?.();
      scheduler.clear();
      releases.forEach(resolve => resolve('cleanup'));
      await Promise.allSettled(requests);
      await tick();
    }
  });

  it('clear 保留未收口的三路真实占用，旧 finally 可启动同 key 新请求', async () => {
    const providers: {source: string; signal: AbortSignal; resolve: (text: string) => void}[] = [];
    const requests: Promise<string>[] = [];
    const scheduler = new VideoTranslationScheduler((source, signal) => new Promise(resolve => {
      // 此端口故意不响应 abort；调度器不能把底层仍在途的名额提前交还。
      providers.push({source, signal, resolve});
    }));
    const observe = (request: Promise<string>) => {
      requests.push(request);
      void request.catch(() => undefined);
      return request;
    };
    try {
      const old = ['same-key', 'old-b', 'old-c'].map(source => observe(scheduler.request(source)));
      await tick();
      expect(providers.map(item => item.source)).toEqual(['same-key', 'old-b', 'old-c']);
      scheduler.clear();
      expect(providers.every(item => item.signal.aborted)).toBe(true);
      expect(await Promise.allSettled(old)).toEqual(old.map(() => ({status: 'rejected',
        reason: expect.objectContaining({name: 'AbortError', message: '视频字幕轨道已切换'})})));

      const next = observe(scheduler.request('same-key'));
      await tick();
      expect(providers).toHaveLength(3);
      providers[0].resolve('old-late-result');
      await tick();
      expect(providers.map(item => item.source)).toEqual(['same-key', 'old-b', 'old-c', 'same-key']);
      expect(scheduler.request('same-key')).toBe(next);
      expect(providers[3].signal.aborted).toBe(false);
      providers[3].resolve('new-result');
      providers[1].resolve('old-b-late');
      providers[2].resolve('old-c-late');
      await expect(next).resolves.toBe('new-result');
    } finally {
      scheduler.clear();
      providers.forEach(item => item.resolve('cleanup'));
      await Promise.allSettled(requests);
      await tick();
    }
  });

  it('两路预取已满且无等待当前句时不枚举任务，新当前句或提升预取可立即占用第三路', async () => {
    const calls: string[] = [];
    const releases = new Map<string, (text: string) => void>();
    const scheduler = new VideoTranslationScheduler(source => new Promise(resolve => {
      calls.push(source);
      releases.set(source, resolve);
    }));
    const jobs = [
      scheduler.request('p1', true),
      scheduler.request('p2', true),
    ];
    await tick();
    expect(calls).toEqual(['p1', 'p2']);

    const valuesSpy = vi.spyOn(Map.prototype, 'values');
    try {
      jobs.push(scheduler.request('p3', true));
      jobs.push(scheduler.request('p4', true));
      expect(valuesSpy).not.toHaveBeenCalled();
    } finally {
      valuesSpy.mockRestore();
    }

    // 提升已排队预取到 current lane，立即启动占用第三路。
    const promoted = scheduler.request('p4');
    await tick();
    expect(calls).toEqual(['p1', 'p2', 'p4']);
    // 对已启动任务重复按 current 请求不重复计数。
    expect(scheduler.request('p4')).toBe(promoted);
    expect(scheduler.request('p1')).toBe(jobs[0]);

    releases.get('p1')!('1');
    releases.get('p2')!('2');
    releases.get('p4')!('4');
    await tick();
    expect(calls).toEqual(['p1', 'p2', 'p4', 'p3']);
    releases.get('p3')!('3');
    await expect(Promise.all(jobs)).resolves.toEqual(['1', '2', '3', '4']);
  });

  it('abortPrefetchesNotIn 立即移除未启动旧预取并中止在途旧预取，不提前释放并发槽', async () => {
    const started: Array<{source: string; signal: AbortSignal; resolve: (text: string) => void; reject: (err: unknown) => void}> = [];
    const scheduler = new VideoTranslationScheduler((source, signal) => new Promise((resolve, reject) => {
      started.push({source, signal, resolve, reject});
    }));

    const activeKeep = scheduler.request('keep-active', true);
    const activeDrop = scheduler.request('drop-active', true);
    const currentJob = scheduler.request('current-job', false);
    const waitingDrop = scheduler.request('drop-waiting', true);
    const waitingKeep = scheduler.request('keep-waiting', true);
    await tick();

    expect(started.map(item => item.source)).toEqual(['keep-active', 'drop-active', 'current-job']);
    const removed = scheduler.abortPrefetchesNotIn(new Set(['keep-active', 'keep-waiting']));
    expect(removed).toEqual(['drop-active', 'drop-waiting']);
    await expect(waitingDrop).rejects.toMatchObject({name: 'AbortError'});

    // 在途旧预取已收到 abort，但尚未结算时不提前腾出并发槽；立即重请求同 key 不复用已中止任务。
    const dropEntry = started.find(item => item.source === 'drop-active')!;
    const keepEntry = started.find(item => item.source === 'keep-active')!;
    const currentEntry = started.find(item => item.source === 'current-job')!;
    expect(dropEntry.signal.aborted).toBe(true);
    expect(keepEntry.signal.aborted).toBe(false);
    expect(currentEntry.signal.aborted).toBe(false);

    const reRequestedDrop = scheduler.request('drop-active', false);
    expect(reRequestedDrop).not.toBe(activeDrop);
    await tick();
    // 三个槽位仍被旧 transport 占满，新请求必须等待旧任务结算后才启动。
    expect(started).toHaveLength(3);

    // 底层响应 abort 后转为 AbortError 并释放槽位，立即启动新的高优先级同 key 请求。
    dropEntry.reject(new Error('network cancelled'));
    await expect(activeDrop).rejects.toMatchObject({name: 'AbortError'});
    await tick();
    expect(started).toHaveLength(4);
    expect(started[3]!.source).toBe('drop-active');
    expect(started[3]!.signal.aborted).toBe(false);
    started[3]!.resolve('D-NEW');
    await expect(reRequestedDrop).resolves.toBe('D-NEW');

    keepEntry.resolve('K');
    currentEntry.resolve('C');
    await tick();

    const nextEntry = started.find(item => item.source === 'keep-waiting')!;
    expect(nextEntry).toBeDefined();
    nextEntry.resolve('W');
    await expect(Promise.all([activeKeep, currentJob, waitingKeep])).resolves.toEqual(['K', 'C', 'W']);

    // 在微任务启动前中止已标记 started 的预取，不调用 translate 且以 AbortError 拒绝。
    const neverCalled = vi.fn(async () => 'never');
    const preMicrotask = new VideoTranslationScheduler(neverCalled);
    const p = preMicrotask.request('pre-microtask', true);
    expect(preMicrotask.abortPrefetchesNotIn(new Set())).toEqual(['pre-microtask']);
    await expect(p).rejects.toMatchObject({name: 'AbortError'});
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
