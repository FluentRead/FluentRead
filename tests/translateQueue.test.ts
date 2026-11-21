import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mockConfig = vi.hoisted((): {maxConcurrentTranslations: unknown} => ({maxConcurrentTranslations: 2}));

vi.mock('@/src/services/config/store', () => ({config: mockConfig}));

import {
  TranslationQueueCancelledError,
  cancelTranslationQueueSession,
  clearTranslationQueue,
  createTranslationQueueSession,
  enqueueTranslation,
  type TranslationQueueLease,
} from '@/src/services/translation/queue';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

beforeEach(() => {
  mockConfig.maxConcurrentTranslations = 2;
});

afterEach(() => {
  clearTranslationQueue();
});

describe('translation queue', () => {
  it('rejects a retry that cannot fit its deadline at queue admission', async () => {
    const task = vi.fn(async () => 'unused');
    const error = new Error('previous translation failure');
    await expect(enqueueTranslation(task, undefined, undefined, {delayMs: 200, deadlineAt: Date.now() + 100, error}))
      .rejects.toBe(error);
    expect(task).not.toHaveBeenCalled();
  });
  it('大页面队列压缩中保留后部取消空槽，其余任务按顺序完成且后续请求仍可执行', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const size = 2300, removed = 2200, caller = new AbortController(), ran: number[] = [];
    const jobs = Array.from({length: size}, (_, index) => enqueueTranslation(async () => {ran.push(index); return index;}, undefined, index === removed ? caller.signal : undefined));
    const settled = Promise.allSettled(jobs); caller.abort(); const outcomes = await settled;
    expect(outcomes[removed]).toMatchObject({status: 'rejected', reason: {name: 'AbortError'}});
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(size - 1);
    expect(ran).toEqual(Array.from({length: size}, (_, index) => index).filter(index => index !== removed));
    await expect(enqueueTranslation(async () => 'next')).resolves.toBe('next');
  });
  it('立即摘除取消信号对应的等待项，不等其他活动请求结束', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const gate = deferred<void>();
    const active = enqueueTranslation(() => gate.promise);
    const controller = new AbortController();
    const task = vi.fn(async () => 'should not run');
    let cancellation: unknown;
    const queued = enqueueTranslation(task, undefined, controller.signal).catch(error => {cancellation = error; return error;});
    try {
      controller.abort();
      await Promise.resolve();
      expect(cancellation).toMatchObject({name: 'AbortError'});
      expect(task).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await Promise.all([active, queued]);
    }
  });

  it('拒绝预先取消且不运行任务，活动请求的取消监听交回任务所有者', async () => {
    const controller = new AbortController(); controller.abort();
    const task = vi.fn(async () => 'unused');
    await expect(enqueueTranslation(task, undefined, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(task).not.toHaveBeenCalled();

    const owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    const gate = deferred<string>();
    const active = enqueueTranslation(async () => gate.promise, undefined, owner.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    owner.abort();
    gate.resolve('owned transport result');
    await expect(active).resolves.toBe('owned transport result');
  });

  it.each(['session', 'clear'] as const)('%s 取消等待项时移除其信号监听，迟到abort不会破坏下一代队列', async mode => {
    mockConfig.maxConcurrentTranslations = 1;
    const gate = deferred<void>(), owner = new AbortController();
    const remove = vi.spyOn(owner.signal, 'removeEventListener');
    const active = enqueueTranslation(() => gate.promise);
    const session = createTranslationQueueSession();
    const queued = enqueueTranslation(async () => 'unused', session, owner.signal).catch(error => error);
    if (mode === 'session') cancelTranslationQueueSession(session);
    else clearTranslationQueue();
    await expect(queued).resolves.toBeInstanceOf(TranslationQueueCancelledError);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    owner.abort();
    const next = enqueueTranslation(async () => 'next');
    gate.resolve();
    await active;
    await expect(next).resolves.toBe('next');
  });

  it('单条等待取消立即结束，不取消同会话其他任务或后续入队', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    const active = enqueueTranslation(() => blocker.promise);
    const session = createTranslationQueueSession();
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => 'cancelled');
    const cancelled = enqueueTranslation(cancelledTask, session, controller.signal);
    const outcome = cancelled.catch(error => error);
    const sibling = enqueueTranslation(async () => 'sibling', session);
    controller.abort();
    try {
      await expect(outcome).resolves.toMatchObject({name: 'AbortError', message: '翻译已取消'});
      expect(cancelledTask).not.toHaveBeenCalled();
      const later = enqueueTranslation(async () => 'later', session);
      blocker.resolve('active');
      await expect(Promise.all([active, sibling, later])).resolves.toEqual(['active', 'sibling', 'later']);
    } finally {
      blocker.resolve('active');
      await Promise.all([active, sibling]);
    }
  });

  it('提前取消的信号不注册等待监听，也不执行任务', async () => {
    const controller = new AbortController();
    controller.abort();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const task = vi.fn(async () => 'never');
    await expect(enqueueTranslation(task, undefined, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(task).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
  });

  it.each(['clear', 'session', 'dequeue'] as const)('%s 归还等待所有权时移除取消监听', async lifecycle => {
    mockConfig.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    const active = enqueueTranslation(() => blocker.promise);
    const session = createTranslationQueueSession();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const task = vi.fn(async () => {
      // 出队后任务可以同步取消自己的传输；等待监听不能先拒绝已取得槽位的调用。
      controller.abort();
      return 'dequeued';
    });
    const pending = enqueueTranslation(task, session, controller.signal);
    const outcome = pending.catch(error => error);
    try {
      expect(addListener).toHaveBeenCalledTimes(1);
      if (lifecycle === 'clear') clearTranslationQueue();
      else if (lifecycle === 'session') cancelTranslationQueueSession(session);
      else blocker.resolve('active');
      const result = await outcome;
      if (lifecycle === 'dequeue') expect(result).toBe('dequeued');
      else {
        expect(result).toBeInstanceOf(TranslationQueueCancelledError);
        expect(task).not.toHaveBeenCalled();
      }
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledWith('abort', addListener.mock.calls[0]![1]);
      controller.abort();
      const survivor = enqueueTranslation(async () => 'survivor');
      blocker.resolve('active');
      await expect(survivor).resolves.toBe('survivor');
    } finally {
      blocker.resolve('active');
      await active;
    }
  });

  it.each(['before-register', 'after-register'] as const)('监听注册边界同步取消 %s 只移除本条等待项一次', async order => {
    mockConfig.maxConcurrentTranslations = 1;
    const blocker = deferred<string>();
    const active = enqueueTranslation(() => blocker.promise);
    const controller = new AbortController();
    const register = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementationOnce((...args) => {
      if (order === 'before-register') controller.abort();
      register(...args);
      if (order === 'after-register') controller.abort();
    });
    const task = vi.fn(async () => 'never');
    const pending = enqueueTranslation(task, undefined, controller.signal);
    try {
      await expect(pending).rejects.toMatchObject({name: 'AbortError'});
      expect(task).not.toHaveBeenCalled();
      const next = enqueueTranslation(async () => 'next');
      blocker.resolve('active');
      await expect(next).resolves.toBe('next');
    } finally {
      blocker.resolve('active');
      await active;
    }
  });

  it('活动任务按自身信号取消后仍持有真实 transport lease', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const controller = new AbortController();
    const transport = deferred<void>();
    const started: string[] = [];
    const active = enqueueTranslation(async lease => {
      started.push('active');
      lease.holdUntil(transport.promise);
      return new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('transport caller stopped'), {name: 'AbortError'}));
      }, {once: true}));
    }, undefined, controller.signal);
    const outcome = active.catch(error => error);
    const next = enqueueTranslation(async () => { started.push('next'); return 'next'; });
    try {
      controller.abort();
      await expect(outcome).resolves.toMatchObject({name: 'AbortError', message: 'transport caller stopped'});
      expect(started).toEqual(['active']);
    } finally {
      transport.resolve();
      await next;
    }
    expect(started).toEqual(['active', 'next']);
  });

  it('保持并发上限，并按 FIFO 顺序启动下一个任务', async () => {
    const controls = Array.from({length: 5}, () => deferred<number>());
    const started: number[] = [];
    const jobs = controls.map((control, index) => enqueueTranslation(async () => {
      started.push(index);
      return control.promise;
    }));

    expect(started).toEqual([0, 1]);

    controls[0].resolve(0);
    await expect(jobs[0]).resolves.toBe(0);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));

    controls[1].resolve(1);
    await expect(jobs[1]).resolves.toBe(1);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));

    controls[2].resolve(2);
    controls[3].resolve(3);
    await Promise.all([jobs[2], jobs[3]]);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    controls[4].resolve(4);
    await expect(jobs[4]).resolves.toBe(4);
  });

  it('向调用方传播任务错误，并继续处理队列中的下一个任务', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const expected = new Error('translation failed');
    const started: string[] = [];

    const failed = enqueueTranslation(async () => {
      started.push('failed');
      throw expected;
    });
    const next = enqueueTranslation(async () => {
      started.push('next');
      return 'ok';
    });

    await expect(failed).rejects.toBe(expected);
    await expect(next).resolves.toBe('ok');
    expect(started).toEqual(['failed', 'next']);
  });

  it('调用方提前结束后仍持有并发槽，直到真实 transport settle', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const transport = deferred<void>();
    const started: string[] = [];

    const cancelledCaller = enqueueTranslation(async (lease) => {
      started.push('first');
      lease.holdUntil(transport.promise);
      return 'caller-stopped';
    });
    const next = enqueueTranslation(async () => {
      started.push('next');
      return 'next-result';
    });

    await expect(cancelledCaller).resolves.toBe('caller-stopped');
    expect(started).toEqual(['first']);

    transport.resolve();
    await expect(next).resolves.toBe('next-result');
    expect(started).toEqual(['first', 'next']);
  });

  it('transport rejection 会被 lease 消费并安全释放并发槽', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const transport = deferred<void>();
    const started: string[] = [];

    const stoppedCaller = enqueueTranslation(async (lease) => {
      started.push('first');
      lease.holdUntil(transport.promise);
      return 'caller-stopped';
    });
    const next = enqueueTranslation(async () => {
      started.push('next');
      return 'next-result';
    });

    await expect(stoppedCaller).resolves.toBe('caller-stopped');
    expect(started).toEqual(['first']);

    transport.reject(new Error('transport failed after caller stopped'));
    await expect(next).resolves.toBe('next-result');
    expect(started).toEqual(['first', 'next']);
  });

  it('跨过内部压缩阈值后仍保持摊销 O(1) 的 FIFO 语义', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const started: number[] = [];
    const count = 2500;

    const results = await Promise.all(Array.from({length: count}, (_, index) =>
      enqueueTranslation(async () => {
        started.push(index);
        return index;
      })));

    expect(results).toEqual(Array.from({length: count}, (_, index) => index));
    expect(started).toEqual(results);
  }, 10_000);

  it('清空队列会拒绝等待任务、保留活跃任务，并允许新 generation 继续执行', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const activeControl = deferred<string>();
    const active = enqueueTranslation(() => activeControl.promise);
    const queued = enqueueTranslation(async () => 'queued');
    const queuedOutcome = queued.catch((error) => error);

    clearTranslationQueue();

    await expect(queuedOutcome).resolves.toBeInstanceOf(TranslationQueueCancelledError);
    const nextGeneration = enqueueTranslation(async () => 'next-generation');
    activeControl.resolve('active');
    await expect(active).resolves.toBe('active');
    await expect(nextGeneration).resolves.toBe('next-generation');
  });

  it('可单独取消会话中的等待任务，并拒绝该会话后续入队', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const activeControl = deferred<string>();
    const active = enqueueTranslation(() => activeControl.promise);
    const session = createTranslationQueueSession();
    const queued = enqueueTranslation(async () => 'session-task', session);
    const queuedOutcome = queued.catch((error) => error);

    cancelTranslationQueueSession(session, 'session stopped');

    const cancellation = await queuedOutcome;
    expect(cancellation).toBeInstanceOf(TranslationQueueCancelledError);
    expect(cancellation.message).toBe('session stopped');
    await expect(enqueueTranslation(async () => 'late', session)).rejects.toMatchObject({
      code: 'TRANSLATION_QUEUE_CANCELLED',
      message: 'session stopped',
    });

    activeControl.resolve('active');
    await expect(active).resolves.toBe('active');
  });

  it('全局清空会使之前创建的会话 generation 过期', async () => {
    const staleSession = createTranslationQueueSession();
    clearTranslationQueue();

    await expect(enqueueTranslation(async () => 'late', staleSession)).rejects.toMatchObject({
      code: 'TRANSLATION_QUEUE_CANCELLED',
      message: '翻译队列会话已过期',
    });
  });

  it('未配置并发数时使用默认的十个并发槽', async () => {
    mockConfig.maxConcurrentTranslations = undefined;
    const controls = Array.from({length: 11}, () => deferred<number>());
    const started: number[] = [];
    const jobs = controls.map((control, index) => enqueueTranslation(async () => {
      started.push(index);
      return control.promise;
    }));

    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    controls[0].resolve(0);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    controls.slice(1).forEach((control, index) => control.resolve(index + 1));
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it.each([
    ['负数回退默认值并继续推进', -7, 10],
    ['字符串回退默认值', '1000', 10],
    ['小数回退默认值', 1.6, 10],
    ['超大数回退默认值', 1_000_000, 10],
    ['合法上限保持一百', 100, 100],
    ['非有限数回退默认值', Number.POSITIVE_INFINITY, 10],
  ] as const)('%s', async (_label, configuredValue, expectedConcurrent) => {
    mockConfig.maxConcurrentTranslations = configuredValue;
    const controls = Array.from({length: expectedConcurrent + 1}, () => deferred<number>());
    const started: number[] = [];
    const jobs = controls.map((control, index) => enqueueTranslation(async () => {
      started.push(index);
      return control.promise;
    }));

    expect(started).toEqual(Array.from({length: expectedConcurrent}, (_, index) => index));
    controls[0].resolve(0);
    await vi.waitFor(() => expect(started).toHaveLength(expectedConcurrent + 1));
    controls.slice(1).forEach((control, index) => control.resolve(index + 1));
    await expect(Promise.all(jobs)).resolves.toHaveLength(expectedConcurrent + 1);
  });

  it('保留显式取消错误，并把 Error 或缺省原因标准化', async () => {
    const explicit = new TranslationQueueCancelledError('explicit');
    const explicitSession = createTranslationQueueSession();
    cancelTranslationQueueSession(explicitSession, explicit);
    await expect(enqueueTranslation(async () => 'late', explicitSession)).rejects.toBe(explicit);

    const errorSession = createTranslationQueueSession();
    cancelTranslationQueueSession(errorSession, new Error('error reason'));
    await expect(enqueueTranslation(async () => 'late', errorSession)).rejects.toMatchObject({
      message: 'error reason',
    });

    const defaultSession = createTranslationQueueSession();
    cancelTranslationQueueSession(defaultSession);
    // 重复取消是幂等操作，不覆盖第一次生成的错误。
    cancelTranslationQueueSession(defaultSession, 'ignored');
    await expect(enqueueTranslation(async () => 'late', defaultSession)).rejects.toMatchObject({
      message: '翻译任务已取消',
    });
  });

  it('拒绝不是队列创建的伪造会话', async () => {
    const invalid = Object.freeze({generation: 0});

    expect(() => cancelTranslationQueueSession(invalid)).toThrow('无效的翻译队列会话');
    await expect(enqueueTranslation(async () => 'never', invalid)).rejects.toThrow('无效的翻译队列会话');
  });

  it('会话取消只影响自己的等待任务', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const activeControl = deferred<string>();
    const active = enqueueTranslation(() => activeControl.promise);
    const other = enqueueTranslation(async () => 'other');
    const session = createTranslationQueueSession();
    const cancelled = enqueueTranslation(async () => 'cancelled', session);
    const outcome = cancelled.catch((error) => error);

    cancelTranslationQueueSession(session, 'stop one session');
    await expect(outcome).resolves.toMatchObject({message: 'stop one session'});
    activeControl.resolve('active');
    await expect(active).resolves.toBe('active');
    await expect(other).resolves.toBe('other');
  });

  it('全局清空会跳过会话取消留下的稀疏槽并拒绝其他等待任务', async () => {
    mockConfig.maxConcurrentTranslations = 1;
    const activeControl = deferred<string>();
    const active = enqueueTranslation(() => activeControl.promise);
    const other = enqueueTranslation(async () => 'other');
    const otherOutcome = other.catch((error) => error);
    const session = createTranslationQueueSession();
    const cancelled = enqueueTranslation(async () => 'cancelled', session);
    const cancelledOutcome = cancelled.catch((error) => error);

    cancelTranslationQueueSession(session, 'session cancelled');
    await expect(cancelledOutcome).resolves.toMatchObject({message: 'session cancelled'});
    clearTranslationQueue();
    await expect(otherOutcome).resolves.toMatchObject({message: '翻译队列已清空'});

    activeControl.resolve('active');
    await expect(active).resolves.toBe('active');
  });

  it('任务结束后不允许继续追加 transport lease', async () => {
    let capturedLease: TranslationQueueLease | undefined;
    await expect(enqueueTranslation(async (lease) => {
      capturedLease = lease;
      return 'done';
    })).resolves.toBe('done');
    await vi.waitFor(() => expect(capturedLease).toBeDefined());
    await Promise.resolve();

    expect(() => capturedLease?.holdUntil(Promise.resolve())).toThrow(
      '翻译队列任务已结束，无法继续占用并发槽',
    );
  });
});
