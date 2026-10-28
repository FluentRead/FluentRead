import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {Script} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

const require = createRequire(import.meta.url);
const {createSiteFocusGuard} = require('../scripts/testing/site-focus-guard.cjs');

function fixture() {
  let callbacks: {onEvent: (event: object) => void; onError: (error: Error) => void};
  let ready!: (value: object) => void;
  const monitor = {ready: new Promise<object>(resolve => {ready = resolve;}), error: null as Error | null,
    stop: vi.fn(async () => {})};
  const start = vi.fn((options: typeof callbacks) => {callbacks = options; return monitor;});
  const browser = {close: vi.fn(async () => {})};
  const guard = createSiteFocusGuard(start);
  const event = (pid: number) => callbacks.onEvent({kind: 'activation', pid, name: 'app', time: 10, monotonicMs: 1});
  const failure = (error: Error) => callbacks.onError(error);
  return {guard, monitor, browser, ready, event, failure, start};
}

describe('站点测试焦点监控，无浏览器受控端口', () => {
  it('监控 ready 前不能完成启动；结束前状态保持未知', async () => {
    const f = fixture(); let done = false;
    const started = f.guard.start().then(() => {done = true;}); await Promise.resolve();
    expect(done).toBe(false); expect(f.guard.snapshot().status).toBe('unknown');
    f.ready({monitorPid: 1}); await started; f.guard.bind(f.browser, 42);
    expect(f.guard.snapshot().status).toBe('unknown'); await f.guard.stop();
    expect(f.guard.snapshot().status).toBe('complete');
  });
  it('绑定 PID 后回查此前事件，锁存失败并仅关闭该浏览器一次', async () => {
    const f = fixture(), started = f.guard.start(); f.ready({monitorPid: 1}); await started;
    f.guard.mark('launch'); f.event(42); f.event(8);
    expect(() => f.guard.bind(f.browser, 42)).toThrow('before identity was confirmed');
    await Promise.resolve(); expect(f.browser.close).toHaveBeenCalledOnce();
    expect(() => f.guard.check()).toThrow();
    await expect(f.guard.stop()).rejects.toThrow();
    expect(f.guard.snapshot()).toMatchObject({status: 'failed', browserPid: 42, observerStopped: true});
    expect(f.guard.snapshot().events.map((event: {pid: number}) => event.pid)).toEqual([42, 8]);
  });
  it('绑定后激活立即锁存并停止后续动作，其他应用事件不能清除失败', async () => {
    const f = fixture(), started = f.guard.start(); f.ready({monitorPid: 1}); await started;
    f.guard.bind(f.browser, 42); f.event(42); f.event(9);
    expect(() => f.guard.check()).toThrow('activation observed'); await Promise.resolve();
    await expect(f.guard.requestClose()).resolves.toBeUndefined();
    expect(f.browser.close).toHaveBeenCalledOnce(); expect(f.guard.snapshot().status).toBe('failed');
  });
  it('关闭时迟到的激活事件与观察器故障不能产生成功判定', async () => {
    const f = fixture(), started = f.guard.start(); f.ready({monitorPid: 1}); await started;
    f.guard.bind(f.browser, 42); f.monitor.stop.mockImplementation(async () => {f.event(42);});
    await expect(f.guard.stop()).rejects.toThrow('activation observed');
    expect(f.guard.snapshot().status).toBe('failed');
    const second = fixture(), next = second.guard.start(); second.ready({monitorPid: 2}); await next;
    second.guard.bind(second.browser, 55); const error = new Error('observer failed');
    second.monitor.stop.mockRejectedValue(error);
    await expect(second.guard.stop()).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION', cause: error});
    expect(second.guard.snapshot()).toMatchObject({status: 'failed', observerStopped: false});
  });
  it('身份缺失和监控错误均不能报告完整采集', async () => {
    const f = fixture(), started = f.guard.start(); f.ready({monitorPid: 1}); await started;
    expect(() => f.guard.bind(f.browser, 0)).toThrow(); await expect(f.guard.stop()).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
    expect(f.guard.snapshot().status).toBe('failed');
    const second = fixture(), next = second.guard.start(); second.ready({monitorPid: 2}); await next;
    const error = new Error('monitor failed'); second.failure(error);
    expect(() => second.guard.check()).toThrow('monitor failed');
    await expect(second.guard.stop()).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION', cause: error});
  });
  it('身份确认尚在等待时，观察器故障立即请求已注册的受控关闭', async () => {
    const f = fixture(), started = f.guard.start(); f.ready({monitorPid: 1}); await started;
    f.guard.register(f.browser); f.failure(new Error('monitor lost'));
    await Promise.resolve(); expect(f.browser.close).toHaveBeenCalledOnce();
    expect(() => f.guard.bind(f.browser, 42)).toThrow('monitor lost');
    await expect(f.guard.stop()).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
  });
});

async function siteRunnerFixture(mode: 'launch-event' | 'run-event' | 'stop-event' | 'normal' | 'diagnostics-failure' | 'identity-failure' | 'diagnostics-write-failure' | 'sample-failure' | 'gesture-event' | 'missing-monitor', platform = 'darwin', background = true) {
  const filename = resolve(__dirname, '../scripts/run-site-translation-test.cjs');
  const runnerRequire = createRequire(filename), calls: string[] = [];
  let report: any, callback!: (event: object) => void, releaseReady!: () => void;
  const ready = new Promise<void>(resolve => {releaseReady = resolve;});
  const emit = () => callback({kind: 'activation', pid: 42, name: 'Edge', time: 100, monotonicMs: 1});
  const monitor = {ready: ready.then(() => ({monitorPid: 123})), error: null,
    stop: async () => {calls.push('monitor.stop'); if (mode === 'stop-event') emit();}};
  const worker = {url: () => 'chrome-extension://owned/background.js'};
  const page = {goto: async () => {calls.push('page.goto'); return null;}, waitForTimeout: async () => {}, isClosed: () => false,
    keyboard: {down: async () => {calls.push('key.down'); if (mode === 'gesture-event') emit();},
      press: async () => {calls.push('key.press');}, up: async () => {calls.push('key.up');}}};
  const context = {serviceWorkers: () => [worker]};
  const launched = {context, launchMode: 'macos-background-cdp', focusPolicy: 'launchservices-no-foreground',
    windowPlacement: {}, close: async () => {calls.push('browser.close'); if (mode === 'diagnostics-failure') throw new Error('close failed');}};
  const helper = {startFocusEventMonitor: ({onEvent}: {onEvent: typeof callback}) => {calls.push('monitor.start'); callback = onEvent; return monitor;},
    launchFocusSafePersistentContext: async () => {calls.push('browser.launch'); if (mode === 'launch-event') emit(); return launched;},
    newPageWithoutForeground: async () => {calls.push('page.new'); if (mode === 'sample-failure') throw Object.assign(new Error('unsafe foreground sample'), {code: 'FOCUS_SAFETY_VIOLATION'}); return page;},
    activateExtensionTabWithoutForeground: async () => {calls.push('page.activate');}};
  if (mode === 'missing-monitor') Object.assign(helper, {startFocusEventMonitor: undefined});
  const diagnostics = {start: async () => {}, attachPage: async () => {}, setExtensionId: () => {}, setPhase: () => {},
    flush: async () => {if (mode === 'diagnostics-failure') throw new Error('diagnostics failed');}, snapshot: () => ({passed: true}), assertClean: () => {}, stop: async () => {calls.push('diagnostics.stop');}};
  const fakeFs = {existsSync: () => true, mkdirSync: () => {}, mkdtempSync: () => '/tmp/owned-profile',
    readFileSync: () => Buffer.from('fixture'), readdirSync: () => [], rmSync: () => {calls.push('profile.remove');},
    rmdirSync: () => {}, writeFileSync: (file: string, contents: string) => {
      if (mode === 'diagnostics-write-failure' && file.endsWith('/runtime-diagnostics.json')) throw new Error('diagnostic write failed');
      if (file.endsWith('/result.json')) report = JSON.parse(contents);
    }};
  const args = {background, case: 'fixture', mode: 'hover', extensionDir: '/build', browserPath: '/edge',
    artifactsDir: '/evidence', runtimeDiagnosticsHelper: '/diagnostics', timeout: 100, service: 'microsoft',
    hoverHotkey: 'Control', url: 'https://example.com/', selector: 'main'};
  const overrides = {parseArgs: () => args, loadRuntimeDiagnostics: () => ({diagnostics, redact: (value: unknown) => String(value)}),
    assertFreshProductionExtension: () => ({}), loadPlaywright: () => ({chromium: {}}), loadFocusSafeHelper: () => helper,
    assertDedicatedProfile: () => {}, waitForHostMathRendering: async () => ({}), waitForStableTarget: async () => {},
    waitForPageContract: async () => {}, capturePageContract: async () => ({}),
    readConfig: async () => ({extensionId: 'owned', config: {service: 'microsoft', display: 1, hotkey: 'Control'}}),
    runHoverCase: async () => {calls.push('case.run'); if (mode === 'run-event') {emit(); throw new Error('context closed');} return {};},
    unloadRuntimePage: async () => {calls.push('page.unload'); return {status: 'observed'};},
    releaseFacebookReadingDialog: async () => {calls.push('dialog.release');}};
  const module = {exports: {}};
  const localRequire = (id: string): unknown => {
    if (id === 'node:fs') return fakeFs;
    if (id === './testing/owned-browser-close.cjs') return {guardBrowserClose: () => {}, getGuardedBrowserPid: async () => {
      if (mode === 'identity-failure') throw Object.assign(new Error('identity unknown'), {code: 'OWNERSHIP_UNKNOWN'}); return 42;
    }};
    return runnerRequire(id);
  };
  const injected = Object.keys(overrides).map(name => `${name} = overrides.${name};`).join('\n') +
    (mode === 'gesture-event' ? '\nrunHoverCase = async page => {await toggleFull(page); return {};};' : '');
  const source = readFileSync(filename, 'utf8') + `\n${injected}\nmodule.exports.testMain = main;`;
  const fakeProcess = {argv: [], platform, stdout: {write: () => {}}, stderr: {write: () => {}}};
  new Script(source, {filename}).runInNewContext({module, exports: module.exports, require: localRequire,
    __dirname: dirname(filename), __filename: filename, process: fakeProcess, overrides, Buffer, URL, setTimeout, clearTimeout});
  const run = (module.exports as {testMain: () => Promise<void>}).testMain();
  return {run, releaseReady, calls, get report() {return report;}};
}

describe('真实站点 runner 焦点监控接入（VM 端口，不启动浏览器）', () => {
  it('启动前等待观察器 ready，并回查启动期间的激活，失败后跳过页面交互', async () => {
    const f = await siteRunnerFixture('launch-event');
    await Promise.resolve(); expect(f.calls).toEqual(['monitor.start']);
    f.releaseReady(); await expect(f.run).rejects.toThrow('before identity was confirmed');
    expect(f.calls).not.toContain('page.new'); expect(f.calls).not.toContain('page.unload');
    expect(f.calls.filter(call => call === 'browser.close')).toHaveLength(1);
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'failed', browserPid: 42}});
  });
  it.each(['run-event', 'stop-event'] as const)('运行或关闭阶段事件 %s 永远不产生成功报告', async mode => {
    const f = await siteRunnerFixture(mode); f.releaseReady(); await expect(f.run).rejects.toThrow('activation observed');
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'failed', browserPid: 42}});
    expect(f.calls.filter(call => call === 'browser.close')).toHaveLength(1);
    expect(f.calls.indexOf('monitor.stop')).toBeGreaterThan(f.calls.indexOf('browser.close'));
    if (mode === 'run-event') {expect(f.calls).not.toContain('page.unload'); expect(f.calls).not.toContain('dialog.release');}
  });
  it('全流程正常时在关闭浏览器及观察器后才写入成功结果', async () => {
    const f = await siteRunnerFixture('normal'); f.releaseReady(); await f.run;
    expect(f.report).toMatchObject({ok: true, focusObservation: {status: 'complete', browserPid: 42, observerStopped: true}});
    expect(f.calls.indexOf('monitor.stop')).toBeGreaterThan(f.calls.indexOf('browser.close'));
  });
  it('浏览器关闭与诊断错误都保留在最终失败报告，仍停止监控', async () => {
    const f = await siteRunnerFixture('diagnostics-failure'); f.releaseReady(); await expect(f.run).rejects.toThrow();
    expect(f.calls).toContain('monitor.stop'); expect(f.calls).not.toContain('profile.remove');
    expect(f.report).toMatchObject({ok: false, cleanupConfirmed: false, finalizationErrors: [{stage: 'runtime-flush'}]});
    expect(f.report.cleanupErrors.map((entry: {message: string}) => entry.message)).toEqual(expect.arrayContaining(['close failed', 'diagnostics failed']));
  });
  it('非 macOS 后台模式在启动前失败并报告焦点能力未知', async () => {
    const f = await siteRunnerFixture('normal', 'linux'); f.releaseReady();
    await expect(f.run).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
    expect(f.calls).not.toContain('browser.launch'); expect(f.calls).not.toContain('monitor.start');
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'unknown'}});
  });
  it('非 macOS 显式 headed 不声明或启动焦点监控', async () => {
    const f = await siteRunnerFixture('normal', 'linux', false); await f.run;
    expect(f.calls).toContain('browser.launch'); expect(f.calls).not.toContain('monitor.start');
    expect(f.report.ok).toBe(true); expect(f.report.focusObservation).toMatchObject({status: 'not-monitored', reason: 'explicit-headed-mode'});
  });
  it('身份确认失败使用矩阵中止码，安全关闭已守护实例并保留原因', async () => {
    const f = await siteRunnerFixture('identity-failure'); f.releaseReady();
    await expect(f.run).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION', cause: {code: 'OWNERSHIP_UNKNOWN'}});
    expect(f.calls.filter(call => call === 'browser.close')).toHaveLength(1);
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'failed', browserPid: null}});
  });
  it('helper 前台采样先于原生事件报错时也跳过取证并立即安全关闭', async () => {
    const f = await siteRunnerFixture('sample-failure'); f.releaseReady();
    await expect(f.run).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION', message: 'unsafe foreground sample'});
    expect(f.calls.filter(call => call === 'browser.close')).toHaveLength(1);
    expect(f.calls).not.toContain('page.unload'); expect(f.calls).not.toContain('dialog.release');
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'failed'}});
  });
  it('诊断文件写入失败仍写最终失败结果并保留错误明细', async () => {
    const f = await siteRunnerFixture('diagnostics-write-failure'); f.releaseReady(); await expect(f.run).rejects.toThrow();
    expect(f.report).toMatchObject({ok: false, cleanupErrors: expect.arrayContaining([{message: 'diagnostic write failed'}])});
  });
  it('旧 helper 缺监控时在启动前以矩阵中止码失败并报告未知', async () => {
    const f = await siteRunnerFixture('missing-monitor');
    await expect(f.run).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
    expect(f.calls).not.toContain('browser.launch');
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'unknown'}});
  });
  it('按键链中观察到焦点故障后不再发送后续手势', async () => {
    const f = await siteRunnerFixture('gesture-event'); f.releaseReady();
    await expect(f.run).rejects.toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
    expect(f.calls).toContain('key.down'); expect(f.calls).not.toContain('key.press'); expect(f.calls).not.toContain('key.up');
    expect(f.report).toMatchObject({ok: false, focusObservation: {status: 'failed'}});
  });
});
