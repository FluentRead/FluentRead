import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LOCAL_TRANSLATION_MODEL_IDS as ids} from '@/src/core/config/localTranslation';

const fake = vi.hoisted(() => ({
  bytes: new Map<string, number>(), complete: new Set<string>(),
  gates: new Map<string, () => void>(), download: vi.fn(), remove: vi.fn(), invalidate: vi.fn(),
  supported: true,
  legacyCached: false,
  check: vi.fn(),
}));
vi.mock('@/src/platform/browser/localTranslationSupport', () => ({supportsHunyuanTranslation: () => fake.supported}));
vi.mock('@/src/features/local-translation/offscreen/artifactStore', () => ({
  LOCAL_MODEL_CACHE: 'download-test-cache',
  getTranslationArtifacts: (model: string) => [ids.opusZhEn, ids.opusJaEn, ids.hunyuan].includes(model as any)
    ? [{repo: model, path: 'weights', size: 12, revision: 'fixed', sha256: 'hash'}] : [],
  artifactComplete: (file: {repo: string}) => fake.check(file),
  artifactDownloadedBytes: async (file: {repo: string}) => fake.bytes.get(file.repo) || 0,
  downloadTranslationArtifact: (...args: any[]) => fake.download(...args),
  removeTranslationArtifact: (...args: any[]) => fake.remove(...args),
  invalidateTranslationArtifactReceipt: (...args: any[]) => fake.invalidate(...args),
}));
vi.mock('@/src/features/local-translation/offscreen/modelCache', () => ({
  isLocalTranslationModelCached: async () => fake.legacyCached,
  removeLocalTranslationModelFiles: vi.fn(async () => undefined),
}));
import {createLocalTranslationDownloadManager} from '@/src/features/local-translation/offscreen/downloads';

const entries = new Map<string, Response>();
beforeEach(() => {
  fake.bytes.clear(); fake.complete.clear(); fake.gates.clear(); entries.clear();
  fake.supported = true;
  fake.legacyCached = false;
  fake.check.mockReset().mockImplementation(async (file: {repo: string}) => fake.complete.has(file.repo));
  vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10_000_000_000, usage: 0})}});
  vi.stubGlobal('caches', {open: async () => ({
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => { entries.set(key, value.clone()); },
  })});
  fake.download.mockReset().mockImplementation((file, signal: AbortSignal, progress) => new Promise<void>((resolve, reject) => {
    fake.bytes.set(file.repo, 4);
    progress(4, false);
    signal.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), {once: true});
    fake.gates.set(file.repo, () => {
      fake.bytes.set(file.repo, 12); fake.complete.add(file.repo); progress(12, true); resolve();
    });
  }));
  fake.remove.mockReset().mockImplementation(async (file) => { fake.bytes.delete(file.repo); fake.complete.delete(file.repo); });
  fake.invalidate.mockReset().mockImplementation(async (file) => {fake.complete.delete(file.repo);});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const phase = async (manager: ReturnType<typeof createLocalTranslationDownloadManager>, model = ids.opusZhEn as string) => (await manager.status()).tasks.find((task) => task.model === model)?.phase;

describe('page-independent local model jobs', () => {
  it('ignores stale or non-ready rechecks and legacy models without tracked artifacts', async () => {
    fake.complete.add(ids.opusZhEn);fake.legacyCached = true;
    const manager = createLocalTranslationDownloadManager(), states = (await manager.status()).tasks;
    const ready = states.find(task => task.model === ids.opusZhEn)!;
    const legacy = states.find(task => task.model === ids.m2m100)!;
    fake.check.mockClear();
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt - 1);
    await manager.reconcileUnavailable(ids.opusJaEn, states.find(task => task.model === ids.opusJaEn)!.updatedAt);
    await manager.reconcileUnavailable(ids.m2m100, legacy.updatedAt);
    expect(fake.check).not.toHaveBeenCalled();
    expect(await phase(manager)).toBe('ready');expect(await phase(manager, ids.m2m100)).toBe('ready');
  });

  it('keeps a paused result if a transfer resolves after cancellation', async () => {
    let release!: () => void;
    fake.download.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await manager.pause(ids.opusZhEn);release();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('paused'));
  });

  it('rechecks missing model files only after an inference error and preserves resumable bytes', async () => {
    fake.complete.add(ids.opusZhEn);
    const notify = vi.fn(async () => undefined), manager = createLocalTranslationDownloadManager({onChange: notify});
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    fake.complete.delete(ids.opusZhEn);fake.bytes.set(ids.opusZhEn, 4);
    expect(await phase(manager)).toBe('ready');
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt);
    const state = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    expect(state).toMatchObject({phase: 'paused', downloadedBytes: 4});
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({tasks: expect.arrayContaining([expect.objectContaining({model: ids.opusZhEn, phase: 'paused'})])}));
    await manager.start(ids.opusZhEn);await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    fake.gates.get(ids.opusZhEn)!();await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });

  it('bounds repeated missing-file checks while a cache query is still pending', async () => {
    fake.complete.add(ids.opusZhEn);const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    fake.complete.delete(ids.opusZhEn);fake.bytes.set(ids.opusZhEn, 4);
    let release!: () => void;const gate = new Promise<void>(resolve => {release = resolve;});
    fake.check.mockClear().mockImplementationOnce(async () => {await gate;return false;});
    const first = manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt);
    await vi.waitFor(() => expect(fake.check).toHaveBeenCalledOnce());
    await Promise.all(Array.from({length: 1000}, () => manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt)));
    expect(fake.check).toHaveBeenCalledOnce();
    release();await first;expect(await phase(manager)).toBe('paused');
  });

  it('does not let a hung check for one model block recovery of another model', async () => {
    fake.complete.add(ids.opusZhEn);fake.complete.add(ids.opusJaEn);
    const manager = createLocalTranslationDownloadManager(), states = (await manager.status()).tasks;
    const first = states.find(task => task.model === ids.opusZhEn)!, second = states.find(task => task.model === ids.opusJaEn)!;
    fake.complete.clear();let release!: () => void;const gate = new Promise<void>(resolve => {release = resolve;});
    fake.check.mockClear().mockImplementationOnce(async () => {await gate;return false;});
    const pending = manager.reconcileUnavailable(ids.opusZhEn, first.updatedAt);
    await vi.waitFor(() => expect(fake.check).toHaveBeenCalledOnce());
    await manager.reconcileUnavailable(ids.opusJaEn, second.updatedAt);
    expect(await phase(manager, ids.opusJaEn)).toBe('paused');
    release();await pending;expect(await phase(manager)).toBe('paused');
  });

  it('keeps stale hung checks from older model versions from overwriting the latest ready state', async () => {
    fake.complete.add(ids.opusZhEn);const manager = createLocalTranslationDownloadManager();await manager.status();
    const releases: Array<() => void> = [];
    fake.check.mockReset().mockImplementation(() => new Promise<boolean>(resolve => {releases.push(() => resolve(false));}));
    const pending: Promise<void>[] = [];
    for (let version = 0; version < 5; version++) {
      const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
      expect(ready.phase).toBe('ready');
      pending.push(manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt));
      await vi.waitFor(() => expect(releases).toHaveLength(version + 1));
      await manager.remove(ids.opusZhEn);fake.gates.clear();
      await manager.start(ids.opusZhEn);await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
      fake.gates.get(ids.opusZhEn)!();await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
    }
    expect(releases).toHaveLength(5); // CacheStorage queries cannot be physically cancelled.
    for (const release of releases) release();await Promise.all(pending);
    expect(await phase(manager)).toBe('ready');
  });

  it('does not let a late integrity recheck overwrite a user deletion', async () => {
    fake.complete.add(ids.opusZhEn);
    const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    fake.check.mockClear().mockImplementationOnce(async () => {await gate;return false;});
    const pending = manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt);
    await vi.waitFor(() => expect(fake.check).toHaveBeenCalled());
    await manager.remove(ids.opusZhEn);release();await pending;
    expect(await phase(manager)).toBe('idle');
  });

  it('offers a nondestructive reverify and retry after a Worker reports a wrong-size artifact', async () => {
    fake.complete.add(ids.opusZhEn);fake.bytes.set(ids.opusZhEn, 12);
    const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt, 'integrity');
    expect((await manager.status()).tasks.find(task => task.model === ids.opusZhEn)).toMatchObject({phase: 'error', error: 'integrity'});
    expect(fake.remove).not.toHaveBeenCalled();
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    expect(fake.invalidate).toHaveBeenCalledOnce();expect(fake.remove).not.toHaveBeenCalled();
    fake.gates.get(ids.opusZhEn)!();await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });

  it('does not fetch after pausing while an integrity retry is revoking its receipt', async () => {
    fake.complete.add(ids.opusZhEn);
    const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt, 'integrity');
    let release!: () => void;
    fake.invalidate.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    await manager.start(ids.opusZhEn);await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await manager.pause(ids.opusZhEn);release();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('paused'));
    expect(fake.download).not.toHaveBeenCalled();
    const paused = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    expect(paused.error).toBeUndefined();expect(paused).not.toHaveProperty('needsReverification');
    const saved = await entries.get('https://fluentread.invalid/local-translation-downloads-v2')!.clone().json();
    expect(saved.tasks.find((task: {model: string}) => task.model === ids.opusZhEn).needsReverification).toBe(true);
    // The saved recovery intent survives a restarted offscreen document even if every key still exists.
    const restarted = createLocalTranslationDownloadManager();
    expect(await phase(restarted)).toBe('paused');
    await restarted.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    expect(fake.invalidate).toHaveBeenCalledTimes(2);
    fake.gates.get(ids.opusZhEn)!();await vi.waitFor(async () => expect(await phase(restarted)).toBe('ready'));
  });

  it.each(['network', 'storage'])('keeps the reverify intent through a %s failure and resumed retry', async kind => {
    fake.complete.add(ids.opusZhEn);const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt, 'integrity');
    if (kind === 'network') fake.download.mockRejectedValueOnce(new Error('network unavailable'));
    else fake.invalidate.mockRejectedValueOnce(new DOMException('storage full', 'QuotaExceededError'));
    await manager.start(ids.opusZhEn);
    await vi.waitFor(async () => expect(await phase(manager)).toBe('error'));
    expect((await manager.status()).tasks.find(task => task.model === ids.opusZhEn)?.error).toBe(kind);
    const restarted = createLocalTranslationDownloadManager();
    expect(await phase(restarted)).toBe('paused');
    await restarted.start(ids.opusZhEn);await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    expect(fake.invalidate).toHaveBeenCalledTimes(2);
    fake.gates.get(ids.opusZhEn)!();await vi.waitFor(async () => expect(await phase(restarted)).toBe('ready'));
  });

  it('preserves reverify after a failed user deletion and clears it after a successful deletion', async () => {
    fake.complete.add(ids.opusZhEn);const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt, 'integrity');
    fake.remove.mockRejectedValueOnce(new Error('disk failure'));
    await expect(manager.remove(ids.opusZhEn)).rejects.toThrow('disk failure');
    expect((await manager.status()).tasks.find(task => task.model === ids.opusZhEn)?.error).toBe('storage');
    const restarted = createLocalTranslationDownloadManager();expect(await phase(restarted)).toBe('paused');
    await restarted.remove(ids.opusZhEn);
    const saved = await entries.get('https://fluentread.invalid/local-translation-downloads-v2')!.clone().json();
    expect(saved.tasks.find((task: {model: string}) => task.model === ids.opusZhEn)).not.toHaveProperty('needsReverification');
    expect(await phase(restarted)).toBe('idle');
  });

  it('keeps ready state when rechecking fails or finds no missing files', async () => {
    fake.complete.add(ids.opusZhEn);
    const manager = createLocalTranslationDownloadManager();
    const ready = (await manager.status()).tasks.find(task => task.model === ids.opusZhEn)!;
    fake.check.mockRejectedValueOnce(new Error('cache offline'));
    await expect(manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt)).rejects.toThrow('cache offline');
    expect(await phase(manager)).toBe('ready');
    await manager.reconcileUnavailable(ids.opusZhEn, ready.updatedAt);
    expect(await phase(manager)).toBe('ready');
  });

  it('does not revive a cancelled queued job when its original state write fails late', async () => {
    const manager = createLocalTranslationDownloadManager();
    await manager.status();
    const open = caches.open.bind(caches);
    let rejectWrite!: (error: Error) => void;
    let first = true;
    vi.spyOn(caches, 'open').mockImplementation(async (name) => {
      const cache = await open(name);
      const put = cache.put.bind(cache);
      cache.put = async (key, value) => {
        if (first) { first = false; await new Promise((_resolve, reject) => { rejectWrite = reject; }); }
        return put(key, value);
      };
      return cache;
    });
    const start = expect(manager.start(ids.opusZhEn)).rejects.toThrow('late disk failure');
    await vi.waitFor(() => expect(rejectWrite).toBeTypeOf('function'));
    const paused = manager.pause(ids.opusZhEn);
    await Promise.resolve();
    rejectWrite(new Error('late disk failure'));
    await start; await paused;
    expect(await phase(manager)).toBe('paused');
    expect(fake.download).not.toHaveBeenCalled();
  });
  it('turns a failed queued-state write into a recoverable storage error', async () => {
    const manager = createLocalTranslationDownloadManager();
    await manager.status();
    const open = caches.open.bind(caches);
    let writes = 0;
    vi.spyOn(caches, 'open').mockImplementation(async (name) => {
      const cache = await open(name);
      const put = cache.put.bind(cache);
      cache.put = async (key, value) => {
        if (++writes === 1) throw new Error('disk full');
        return put(key, value);
      };
      return cache;
    });
    await expect(manager.start(ids.opusZhEn)).rejects.toThrow('disk full');
    await vi.waitFor(async () => expect(await phase(manager)).toBe('error'));
    expect(fake.download).not.toHaveBeenCalled();
  });

  it('stops before fetching when paused during storage estimation', async () => {
    let estimate!: (value: object) => void;
    vi.stubGlobal('navigator', {storage: {estimate: () => new Promise((resolve) => { estimate = resolve; })}});
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(estimate).toBeTypeOf('function'));
    await manager.pause(ids.opusZhEn);
    estimate({});
    await vi.waitFor(async () => expect(await phase(manager)).toBe('paused'));
    expect(fake.download).not.toHaveBeenCalled();
  });

  it('does not perform preflight if the queued controller is already aborted', async () => {
    const OriginalController = AbortController;
    vi.stubGlobal('AbortController', class extends OriginalController { constructor() { super(); this.abort(); } });
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.download).not.toHaveBeenCalled();
  });
  it('restores completed models and keeps legacy models removable but not downloadable', async () => {
    fake.complete.add(ids.opusZhEn);
    fake.legacyCached = true;
    const manager = createLocalTranslationDownloadManager({onChange: async () => { throw new Error('page closed'); }});
    expect(await phase(manager)).toBe('ready');
    expect(await phase(manager, ids.m2m100)).toBe('ready');
    await expect(manager.start(ids.m2m100)).rejects.toThrow('LEGACY_MODEL');
    await expect(manager.start('unknown')).rejects.toThrow('INVALID_MODEL');
    await manager.remove(ids.m2m100);
    expect(await phase(manager, ids.m2m100)).toBe('idle');
    await manager.pause(ids.opusZhEn);
    expect(await phase(manager)).toBe('ready');
  });

  it.each([
    [new Error('LOCAL_TRANSLATION_INTEGRITY'), 'integrity'],
    [new Error('fetch failed'), 'network'],
    ['untyped failure', 'network'],
  ])('classifies a transfer failure and allows a clean retry', async (error, code) => {
    fake.download.mockRejectedValueOnce(error);
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);
    await vi.waitFor(async () => expect(await phase(manager)).toBe('error'));
    expect((await manager.status()).tasks.find((task) => task.model === ids.opusZhEn)?.error).toBe(code);
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });

  it('reports speed from elapsed bytes and preserves valid persisted idle state', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    entries.set('https://fluentread.invalid/local-translation-downloads-v2', new Response(JSON.stringify({version:2,tasks:[{model:ids.opusZhEn,phase:'idle',updatedAt:now + 50}]})));
    const manager = createLocalTranslationDownloadManager();
    expect(await phase(manager)).toBe('idle');
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.gates.has(ids.opusZhEn)).toBe(true));
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    fake.download.mock.calls[0]![2](8, false);
    const task = (await manager.status()).tasks.find((task) => task.model === ids.opusZhEn)!;
    expect(task.bytesPerSecond).toBe(8);
    expect(task.updatedAt).toBeGreaterThan(now + 50);
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });

  it('deduplicates removal and refuses to start until the disk operation finishes', async () => {
    let finish!: () => void;
    fake.remove.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const manager = createLocalTranslationDownloadManager();
    const deletion = manager.remove(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.remove).toHaveBeenCalledOnce());
    await expect(manager.start(ids.opusZhEn)).rejects.toThrow('REMOVING');
    expect((await manager.remove(ids.opusZhEn)).tasks.find((task) => task.model === ids.opusZhEn)?.phase).toBe('removing');
    finish(); await deletion;
    expect(await phase(manager)).toBe('idle');
    fake.remove.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(manager.remove(ids.opusZhEn)).rejects.toThrow('disk unavailable');
    expect(await phase(manager)).toBe('error');
  });

  it('waits for an aborted active transfer before resuming', async () => {
    let rejectTransfer!: (error: Error) => void;
    fake.download.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectTransfer = reject; }));
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await manager.pause(ids.opusZhEn);
    const resumed = manager.start(ids.opusZhEn);
    await Promise.resolve();
    expect(fake.download).toHaveBeenCalledOnce();
    rejectTransfer(new DOMException('Paused', 'AbortError'));
    await resumed;
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledTimes(2));
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });
  it('rejects an unsupported Hunyuan runtime before transferring model files', async () => {
    fake.supported = false;
    await expect(createLocalTranslationDownloadManager().start(ids.hunyuan)).rejects.toThrow('BROWSER_UNSUPPORTED');
    expect(fake.download).not.toHaveBeenCalled();
  });
  it('returns immediately and keeps one job while settings pages detach and reattach', async () => {
    const change = vi.fn(async () => undefined);
    const manager = createLocalTranslationDownloadManager({onChange: change});
    const acknowledgement = await manager.start(ids.opusZhEn);
    expect(acknowledgement.tasks.find((task) => task.model === ids.opusZhEn)?.phase).not.toBe('ready');
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await manager.status();
    await manager.status();
    await manager.start(ids.opusZhEn);
    expect(fake.download).toHaveBeenCalledOnce();
    expect(await phase(manager)).toBe('downloading');
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
    await manager.start(ids.opusZhEn);
    expect(fake.download).toHaveBeenCalledOnce();
  });

  it('restores disk progress as paused after the offscreen document restarts, never as a running phantom job', async () => {
    const first = createLocalTranslationDownloadManager();
    await first.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await first.pause(ids.opusZhEn);
    await vi.waitFor(async () => expect(await phase(first)).toBe('paused'));
    const reopened = createLocalTranslationDownloadManager();
    const task = (await reopened.status()).tasks.find((task) => task.model === ids.opusZhEn)!;
    expect(task).toMatchObject({phase: 'paused', downloadedBytes: 4});
    expect(fake.download).toHaveBeenCalledOnce();
    await reopened.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledTimes(2));
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(reopened)).toBe('ready'));
  });

  it('can delete a queued model without waiting for another large download', async () => {
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.hunyuan);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await manager.start(ids.opusZhEn);
    expect(await phase(manager)).toBe('queued');
    await manager.remove(ids.opusZhEn);
    expect(await phase(manager)).toBe('idle');
    expect(fake.remove).toHaveBeenCalledOnce();
    fake.gates.get(ids.hunyuan)!();
    await vi.waitFor(async () => expect(await phase(manager, ids.hunyuan)).toBe('ready'));
    expect(fake.download).toHaveBeenCalledOnce();
  });

  it('aborts an active download before deletion and never resurrects deleted files as ready', async () => {
    const beforeRemove = vi.fn();
    const manager = createLocalTranslationDownloadManager({beforeRemove});
    await manager.start(ids.opusZhEn);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await manager.remove(ids.opusZhEn);
    expect(fake.download.mock.calls[0]![1].aborted).toBe(true);
    expect(beforeRemove).toHaveBeenCalledWith(ids.opusZhEn);
    expect(await phase(manager)).toBe('idle');
    expect(fake.bytes.has(ids.opusZhEn)).toBe(false);
    const reopened = createLocalTranslationDownloadManager();
    expect(await phase(reopened)).toBe('idle');
  });

  it('continues a paused queued job only after an explicit resume, without duplicate execution', async () => {
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.hunyuan);
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledOnce());
    await manager.start(ids.opusZhEn);
    await manager.pause(ids.opusZhEn);
    expect(await phase(manager)).toBe('paused');
    await manager.start(ids.opusZhEn);
    fake.gates.get(ids.hunyuan)!();
    await vi.waitFor(() => expect(fake.download).toHaveBeenCalledTimes(2));
    fake.gates.get(ids.opusZhEn)!();
    await vi.waitFor(async () => expect(await phase(manager)).toBe('ready'));
  });

  it('reports insufficient disk space before opening a download', async () => {
    vi.stubGlobal('navigator', {storage: {estimate: async () => ({quota: 10, usage: 9})}});
    const manager = createLocalTranslationDownloadManager();
    await manager.start(ids.opusZhEn);
    await vi.waitFor(async () => expect(await phase(manager)).toBe('error'));
    expect((await manager.status()).tasks.find((task) => task.model === ids.opusZhEn)?.error).toBe('storage');
    expect(fake.download).not.toHaveBeenCalled();
  });
});

it('真实 offscreen 注入的通知回执未返回时，模型状态读取仍可结束', async () => {
  vi.useFakeTimers();
  const callbacks: Array<() => void> = [];
  const page = new EventTarget();
  vi.stubGlobal('window', page); vi.stubGlobal('self', page);
  vi.stubGlobal('chrome', {runtime: {id: 'fixture', onMessage: {addListener: vi.fn()},
    sendMessage: (_message: unknown, callback: () => void) => {callbacks.push(callback);}, lastError: undefined}});
  try {
    const {startOffscreenApp} = await import('@/src/app/offscreen/runtime');
    const {getLocalTranslationModelStatus} = await import('@/src/features/local-translation/offscreen/translation');
    startOffscreenApp();
    let settled = false; const status = getLocalTranslationModelStatus().then(() => {settled = true;});
    for (let index = 0; index < 80 && callbacks.length === 0; index++) await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
    callbacks.splice(0).forEach(callback => callback()); await status;
  } finally {callbacks.splice(0).forEach(callback => callback()); page.dispatchEvent(new Event('pagehide')); vi.useRealTimers();}
});

it('后台存储回执挂起时可完成模型下载，迟到回执后只发送最新完成状态', async () => {
  vi.resetModules(); vi.useFakeTimers();
  const page = new EventTarget(), sent: any[] = [], callbacks: Array<() => void> = [];
  vi.stubGlobal('window', page); vi.stubGlobal('self', page);
  vi.stubGlobal('chrome', {runtime: {id: 'fixture', onMessage: {addListener: vi.fn()},
    sendMessage: (message: unknown, callback: () => void) => {sent.push(message); callbacks.push(callback);}, lastError: undefined}});
  try {
    const {startOffscreenApp} = await import('@/src/app/offscreen/runtime');
    const {getLocalTranslationModelStatus, prepareLocalTranslationModel} = await import('@/src/features/local-translation/offscreen/translation');
    startOffscreenApp();
    const initial = getLocalTranslationModelStatus();
    for (let i = 0; i < 100 && callbacks.length === 0; i++) await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); await initial;
    await prepareLocalTranslationModel(ids.opusZhEn);
    for (let i = 0; i < 100 && !fake.gates.has(ids.opusZhEn); i++) await Promise.resolve();
    expect(fake.gates.has(ids.opusZhEn)).toBe(true);
    fake.gates.get(ids.opusZhEn)!();
    let stored: any;
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
      stored = await entries.get('https://fluentread.invalid/local-translation-downloads-v2')?.clone().json();
      if (stored?.tasks.find((task: any) => task.model === ids.opusZhEn)?.phase === 'ready') break;
    }
    expect(stored?.tasks.find((task: any) => task.model === ids.opusZhEn)?.phase).toBe('ready');
    expect(sent).toHaveLength(1);
    callbacks.shift()!();
    for (let i = 0; i < 30 && sent.length < 2; i++) await Promise.resolve();
    expect(sent).toHaveLength(2);
    expect(sent[1].snapshot.tasks.find((task: any) => task.model === ids.opusZhEn)?.phase).toBe('ready');
    callbacks.shift()!();
  } finally {callbacks.splice(0).forEach(callback => callback()); page.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.resetModules();}
});

it('真实离屏模型到真实后台状态处理：迟到存储回执不会覆盖最新完成快照', async () => {
  vi.resetModules(); vi.useFakeTimers();
  const {createLocalTranslationBackgroundHandlers} = await import('@/src/features/local-translation/background/handlers');
  const {LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY} = await import('@/src/core/config/localTranslation');
  let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
  const stored = new Map<string, unknown>(), sends: any[] = [];
  const storage = {
    get: vi.fn(async (key: string) => {await gate; return {[key]: stored.get(key)};}),
    set: vi.fn(async (value: Record<string, unknown>) => {for (const [key, item] of Object.entries(value)) stored.set(key, item);}),
  };
  const handler = createLocalTranslationBackgroundHandlers({storage, isTrustedProgress: () => true, offscreen: {} as never} as never)
    .find(item => item.type === 'fluentReadLocalTranslationDownloadProgress')!;
  const page = new EventTarget(); vi.stubGlobal('window', page); vi.stubGlobal('self', page);
  vi.stubGlobal('chrome', {runtime: {id: 'fixture', onMessage: {addListener: vi.fn()}, lastError: undefined,
    sendMessage: (message: unknown, callback: () => void) => {sends.push(message); void Promise.resolve(handler.handle(message as never, {} as never)).then(callback, callback);}}});
  try {
    const {startOffscreenApp} = await import('@/src/app/offscreen/runtime');
    const {getLocalTranslationModelStatus, prepareLocalTranslationModel} = await import('@/src/features/local-translation/offscreen/translation');
    startOffscreenApp(); const initial = getLocalTranslationModelStatus();
    for (let i = 0; i < 100 && storage.get.mock.calls.length === 0; i++) await Promise.resolve();
    expect(storage.get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await initial;
    await prepareLocalTranslationModel(ids.opusZhEn);
    for (let i = 0; i < 100 && !fake.gates.has(ids.opusZhEn); i++) await Promise.resolve();
    expect(fake.gates.has(ids.opusZhEn)).toBe(true); fake.gates.get(ids.opusZhEn)!();
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
      const value: any = await entries.get('https://fluentread.invalid/local-translation-downloads-v2')?.clone().json();
      if (value?.tasks.find((task: any) => task.model === ids.opusZhEn)?.phase === 'ready') break;
    }
    expect((await getLocalTranslationModelStatus()).tasks.find(task => task.model === ids.opusZhEn)?.phase).toBe('ready');
    expect(sends).toHaveLength(1);
    release();
    for (let i = 0; i < 100 && storage.set.mock.calls.length < 2; i++) await Promise.resolve();
    expect(sends).toHaveLength(2); expect(storage.set).toHaveBeenCalledTimes(2);
    const mirrored = stored.get(LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY) as {tasks: Array<{model: string; phase: string}>};
    expect(mirrored.tasks.find(task => task.model === ids.opusZhEn)?.phase).toBe('ready');
  } finally {release(); page.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.resetModules();}
});
