/**
 * @file tests/processRegression.test.ts
 * 文件职责：让统一 Vitest 入口完整执行仍依赖原生 Node 进程语义的回归测试。
 * 主要内容：逐一登记原生测试文件，在真实子进程中运行原套件，校验 TAP 完成状态并报告完整输出。
 * 模块边界：不改写原生断言、信号或清理行为；只管理本测试启动的进程树，不连接浏览器或线上服务。
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

const nativeGroups = [
  {name: 'release packaging and publication', files: [
    'tests/releaseBundle.test.mjs',
    'tests/releaseManifest.test.mjs',
    'tests/releasePublish.test.mjs',
    'tests/releaseEdge.test.mjs',
  ], arguments: ['--test-concurrency=1']},
  {name: 'agent bridge', files: ['tests/agentBridge.test.mjs'], arguments: []},
  {name: 'pinned userscript language resources', files: ['tests/pinnedUserscriptLanguagePreflight.test.mjs'], arguments: []},
  {name: 'focus-safe lifecycle', files: [
    'tests/focusSafeBrowserOrdinaryLifecycle.test.mjs',
    'tests/focusSafeBrowserBackgroundSignal.test.mjs',
    'tests/focusSafeBrowserBackgroundLifecycle.test.mjs',
  ], arguments: ['--test-concurrency=1']},
  {name: 'document HTTP evidence', files: ['tests/documentLiveHttpEvidence.test.mjs'], arguments: []},
  {name: 'chatgpt plan bridge', files: ['tests/chatgptPlanBridge.test.mjs'], arguments: []},
];
const childTimeoutMs = 60_000, cleanupTimeoutMs = 5_000;
type Exit = {code: number | null; signal: NodeJS.Signals | null};
type OwnedChild = {child: ChildProcess; stop: () => Promise<void>};
const activeChildren = new Set<OwnedChild>();

function nativeFiles(directory = 'tests'): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const filename = `${directory}/${entry.name}`;
    return entry.isDirectory() ? nativeFiles(filename) : entry.isFile() && entry.name.endsWith('.test.mjs') ? [filename] : [];
  });
}

async function runNativeGroup(group: typeof nativeGroups[number]) {
  const args = ['--test', '--test-reporter=tap', ...group.arguments, ...group.files.map(filename => resolve(filename))];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    // 普通 fork/spawn 后代继承此专属进程组；超时回收不会触及 Vitest 或其他聊天的进程。
    detached: process.platform !== 'win32',
  });
  let stdout = '', stderr = '', spawnError: Error | undefined, closed = false, timedOut = false;
  let groupGone = process.platform === 'win32';
  child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', value => {stdout += value;});child.stderr!.on('data', value => {stderr += value;});
  child.once('error', error => {spawnError = error;});
  const completed = new Promise<Exit>(done => child.once('close', (code, signal) => {closed = true;done({code, signal});}));
  const diagnostics = (reason: unknown) => `${group.name}: ${String(reason)}\nCommand: ${process.execPath} ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  async function waitForOwnedGroupExit() {
    if (process.platform === 'win32' || !child.pid) {groupGone = true;return;}
    const deadline = performance.now() + cleanupTimeoutMs;
    for (;;) {
      try {process.kill(-child.pid, 0);}
      catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') {groupGone = true;return;}throw error;}
      if (performance.now() >= deadline) throw new Error(diagnostics('Owned process group remained after subprocess close'));
      await new Promise<void>(done => setTimeout(done, 20));
    }
  }
  let stopTask: Promise<void> | undefined;
  const owner: OwnedChild = {child, stop() {
    return stopTask ??= (async () => {
      if (closed && groupGone) return;
      if (child.pid) {
        if (process.platform === 'win32') {
          // Windows 无 POSIX 进程组；taskkill 的 /T 同样仅回收本测试拥有的进程树。
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', shell: false});
          let killError: Error | undefined;
          killer.once('error', error => {killError = error;});
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((done, fail) => {
              killer.once('close', code => killError ? fail(killError) : code === 0 || closed ? done() : fail(new Error(`taskkill exited ${code}`)));
              killTimer = setTimeout(() => {killer.kill('SIGKILL');fail(new Error('taskkill cleanup timed out'));}, cleanupTimeoutMs);
            });
          } finally {clearTimeout(killTimer);}
        } else {
          try {process.kill(-child.pid, 'SIGKILL');}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
        }
      }
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([completed, new Promise<never>((_done, fail) => {
          cleanupTimer = setTimeout(() => fail(new Error(diagnostics('Owned subprocess did not close after termination'))), cleanupTimeoutMs);
        })]);
      } finally {clearTimeout(cleanupTimer);}
      await waitForOwnedGroupExit();
    })();
  }};
  activeChildren.add(owner);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_done, fail) => {
      timer = setTimeout(() => {
        timedOut = true;
        void owner.stop().then(
          () => fail(new Error(diagnostics(`Native subprocess exceeded ${childTimeoutMs} ms`))),
          error => fail(new Error(diagnostics(error))),
        );
      }, childTimeoutMs);
    });
    const exit = await Promise.race([completed, deadline]);
    clearTimeout(timer);
    // SIGKILL 的 close 回执可能先于 deadline 的拒绝；超时仍须明确失败。
    if (timedOut) {await owner.stop();throw new Error(diagnostics(`Native subprocess exceeded ${childTimeoutMs} ms`));}
    await waitForOwnedGroupExit();
    const evidence = diagnostics(spawnError ?? JSON.stringify(exit));
    expect(spawnError, evidence).toBeUndefined();expect(exit.code, evidence).toBe(0);expect(exit.signal, evidence).toBeNull();
    const metrics = new Map<string, number>();
    for (const metric of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const matches = [...stdout.matchAll(new RegExp(`^# ${metric} (\\d+)\\r?$`, 'gm'))];
      expect(matches, evidence).toHaveLength(1);metrics.set(metric, Number(matches[0][1]));
    }
    expect(metrics.get('tests'), evidence).toBeGreaterThan(0);
    expect(metrics.get('pass'), evidence).toBe(metrics.get('tests'));
    for (const metric of ['fail', 'cancelled', 'skipped', 'todo']) expect(metrics.get(metric), evidence).toBe(0);
  } catch (error) {
    if (!closed || !groupGone) await owner.stop();
    throw new Error(diagnostics(error), {cause: error});
  } finally {
    clearTimeout(timer);
    if (closed && groupGone) activeChildren.delete(owner);
  }
}

afterEach(async () => {
  try {await Promise.all([...activeChildren].map(owner => owner.stop()));}
  finally {activeChildren.clear();}
}, cleanupTimeoutMs * 3 + 1_000);

describe('native process regressions through the unified Vitest runner', () => {
  it('registers every native Node test file exactly once', () => {
    const registered = nativeGroups.flatMap(group => group.files);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(nativeFiles().sort());
  });
  it.each(nativeGroups)('runs $name with all native assertions and cleanup', runNativeGroup, childTimeoutMs + cleanupTimeoutMs * 3 + 2_000);
});
