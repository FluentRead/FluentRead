/**
 * @file tests/focusSafeBrowserBackgroundLifecycle.test.mjs
 * 验证 macOS 原生 helper 与实际 owned guard 的组合生命周期：保持原计时预算，
 * 对测试父进程创建的 Node actor 做实际身份查询，覆盖 pending、超时、
 * 身份拒绝与混合重复信号。VM seam 不新增生产导出，不启动浏览器或网络。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {Script} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const fixturePath = fileURLToPath(import.meta.url);
const helperPath = path.resolve(process.env.FLUENTREAD_SIGNAL_TEST_HELPER ||
  fileURLToPath(new URL('../scripts/testing/focus-safe-browser.cjs', import.meta.url)));
const guardPath = path.resolve(process.env.FLUENTREAD_SIGNAL_TEST_GUARD ||
  fileURLToPath(new URL('../scripts/testing/owned-browser-close.cjs', import.meta.url)));
const require = createRequire(import.meta.url);
const actualGuard = require(guardPath);
const options = {timeout: 15000, concurrency: false};
// Error messages may contain process output. Report only structural error names
// and codes so CI exposes secondary cleanup failures without dumping payloads.
const closeReceiptCodes = error => {
  const codes = value => ({name: value?.name, code: value?.code});
  return JSON.stringify({error: codes(error), cause: codes(error?.cause),
    errors: Array.isArray(error?.errors) ? error.errors.map(codes) : []});
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const send = value => new Promise((yes, no) => process.send(value, error => error ? no(error) : yes()));
function loadFactory(processPort, errors = []) {
  const realRequire = createRequire(helperPath);
  const module = {exports: {}};
  const requirePort = name => name === './owned-browser-close.cjs' ? actualGuard : realRequire(name);
  const source = fs.readFileSync(helperPath, 'utf8');
  new Script(source + '\nmodule.exports.__testFactory = createMacBackgroundSession;\n',
    {filename: helperPath}).runInNewContext({module, exports: module.exports,
    require: requirePort, process: processPort, setTimeout, clearTimeout,
    console: {error: (...values) => errors.push(values), log() {}}});
  return module.exports.__testFactory;
}
class ProcessPort extends EventEmitter {
  platform = process.platform;
  exits = [];
  exitReady = deferred();
  exit(code) {this.exits.push(code); this.exitReady.resolve(code);}
}
function watchChild(child) {
  const messages = [], waiters = [];
  let closed = false, exit, stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => {stderr += value;});
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; exit = {code, signal}; resolve(exit);
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Child closed before ' + waiter.label + ': ' + JSON.stringify(exit) + stderr));
  }));
  child.on('message', value => {
    messages.push(value);
    for (const waiter of [...waiters]) if (waiter.match(value)) {
      waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value);
    }
  });
  return {child, messages, done, get closed() {return closed;}, get stderr() {return stderr;},
    wait(match, label) {
      const existing = messages.find(match);
      if (existing) return Promise.resolve(existing);
      if (closed) return Promise.reject(new Error('Child already closed before ' + label + ': ' + JSON.stringify(exit)));
      return new Promise((resolve, reject) => waiters.push({match, label, resolve, reject}));
    }};
}
async function actor(t, holdTerm = false) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-signal-composition-'));
  const watch = watchChild(fork(fixturePath, ['--actor', '--user-data-dir=' + profile, ...(holdTerm ? ['--hold-term'] : [])],
    {execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']}));
  const extraPaths = [];
  t.after(async () => {
    if (!watch.closed) watch.child.kill('SIGKILL');
    await watch.done;
    for (const ownedPath of [profile, ...extraPaths]) fs.rmSync(ownedPath, {recursive: true, force: true});
  });
  const ready = await watch.wait(value => value.kind === 'actor-ready', 'actor ready');
  assert.equal(ready.pid, watch.child.pid);
  return Object.assign(watch, {profile, extraPaths});
}
function guardedFactory(owner, processPort, errors = []) {
  const native = deferred(), entered = deferred(), calls = {native: 0, cdp: 0, detach: 0};
  const browser = {
    close() {calls.native++; entered.resolve(); return native.promise;},
    async newBrowserCDPSession() {
      calls.cdp++;
      return {async send(method) {
        assert.equal(method, 'SystemInfo.getProcessInfo');
        return {processInfo: [{type: 'browser', id: owner.child.pid}]};
      }, async detach() {calls.detach++;}};
    },
  };
  const context = {browser: () => browser};
  const session = loadFactory(processPort, errors)(browser, context, {});
  actualGuard.guardBrowserClose(session, owner.profile);
  return {session, native, entered, calls};
}
const assertRouted = port => {
  assert.equal(port.listenerCount('SIGINT'), 1);
  assert.equal(port.listenerCount('SIGTERM'), 1);
};
const assertReleased = port => {
  assert.equal(port.listenerCount('SIGINT'), 0);
  assert.equal(port.listenerCount('SIGTERM'), 0);
};

if (process.argv.includes('--actor')) {
  const exit = async () => {await send({kind: 'actor-exit', pid: process.pid}); process.exit(0);};
  process.on('SIGTERM', () => {
    void send({kind: 'actor-term', pid: process.pid}).then(() => {
      if (!process.argv.includes('--hold-term')) return exit();
    });
  });
  process.on('message', value => {if (value === 'exit-actor') void exit();});
  await send({kind: 'actor-ready', pid: process.pid});
} else if (process.argv.includes('--helper-worker')) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  const owner = {child: {pid: Number(arg('--owner-pid'))}, profile: arg('--owner-profile')};
  const callbacks = new WeakMap();
  const realPort = {
    platform: process.platform,
    on(name, callback) {
      const decorated = (...values) => {process.send({kind: 'signal-routed', signal: name}); return callback(...values);};
      callbacks.set(callback, decorated); process.on(name, decorated); return this;
    },
    once(name, callback) {
      const decorated = (...values) => {process.send({kind: 'signal-routed', signal: name}); return callback(...values);};
      callbacks.set(callback, decorated); process.once(name, decorated); return this;
    },
    off(name, callback) {process.off(name, callbacks.get(callback) || callback); return this;},
    exit: code => process.exit(code),
  };
  const h = guardedFactory(owner, realPort);
  process.on('message', value => {if (value === 'release-native') h.native.resolve();});
  assert.equal(await actualGuard.getGuardedBrowserPid(h.session), owner.child.pid);
  await send({kind: 'worker-ready', pid: process.pid});
  const closing = h.session.close();
  await h.entered.promise;
  await send({kind: 'native-pending'});
  closing.then(() => process.send({kind: 'guard-settled', status: 'fulfilled'}), error => {
    process.send({kind: 'guard-settled', status: 'rejected', code: error.code});
  });
} else {
  console.log(JSON.stringify({kind: 'background-signal-composition-inputs', helperPath, guardPath,
    helperSha256: createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex'),
    guardSha256: createHash('sha256').update(fs.readFileSync(guardPath)).digest('hex'),
    fixtureSha256: createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),
    budgets: 'Unmodified actual guard; native5000/capture1500/detach500/PS750/grace250/TERM750/KILL1500',
    scope: 'Serial pure ports plus exact parent-owned Node actors and helper workers; no browser/network/build'}));

  test('unexpected close diagnostics retain secondary codes without error messages', options, () => {
    const native = Object.assign(new Error('synthetic-private-native-message'), {code: 'NATIVE_CLOSE_TIMEOUT'});
    const cleanup = Object.assign(new Error('synthetic-private-process-output'), {code: 'PS_TIMEOUT'});
    const combined = new AggregateError([native, cleanup], 'synthetic-private-summary', {cause: native});
    const report = JSON.parse(closeReceiptCodes(combined));
    assert.equal(report.error.name, 'AggregateError');
    assert.equal(report.cause.code, 'NATIVE_CLOSE_TIMEOUT');
    assert.deepEqual(report.errors.map(error => error.code), ['NATIVE_CLOSE_TIMEOUT', 'PS_TIMEOUT']);
    assert.equal(closeReceiptCodes(combined).includes('synthetic-private'), false);
    assert.deepEqual(JSON.parse(closeReceiptCodes(native)).errors, []);
  });

  test('non-arrow receivers, self registration and settled fulfilled cache preserve one whole close', options, async () => {
    const port = new ProcessPort(), native = deferred(), cleanup = deferred(), entered = deferred();
    const value = Object.freeze({receipt: 'same-reference'});
    let nativeCalls = 0, delegateCalls = 0;
    const browser = {close: function() {assert.equal(this, browser); nativeCalls++; return native.promise;}};
    const session = loadFactory(port)(browser, {}, {});
    session.useGuardedClose(function() {
      assert.equal(this, session); delegateCalls++; entered.resolve();
      return session.closeBrowserConnection().then(() => cleanup.promise).then(() => value);
    });
    const wrapper = session.close;
    session.useGuardedClose(session.close);
    const first = session.close();
    assert.strictEqual(session.close(), first);
    await entered.promise;
    assertRouted(port);
    session.useGuardedClose(session.close);
    native.resolve(); cleanup.resolve();
    assert.strictEqual(await first, value);
    assertReleased(port);
    session.useGuardedClose(wrapper);
    assert.strictEqual(session.close(), first);
    assert.strictEqual(await session.close(), value);
    assertReleased(port);
    assert.equal(nativeCalls, 1); assert.equal(delegateCalls, 1); assert.deepEqual(port.exits, []);
  });

  test('settled rejected cache preserves exact error and refuses listener reinstallation', options, async () => {
    const port = new ProcessPort(), error = new Error('exact rejection');
    const session = loadFactory(port)({close() {assert.fail('transport not requested');}}, {}, {});
    let calls = 0;
    session.useGuardedClose(function() {assert.equal(this, session); calls++; throw error;});
    const first = session.close();
    await assert.rejects(first, value => value === error);
    assertReleased(port);
    session.useGuardedClose(session.close);
    session.useGuardedClose(() => {assert.fail('settled delegate must not be replaced');});
    assert.strictEqual(session.close(), first);
    await assert.rejects(session.close(), value => value === error);
    assert.equal(calls, 1); assertReleased(port); assert.deepEqual(port.exits, []);
  });

  test('foreground native session keeps the shared signal/delegate lifecycle and truthful metadata', options, async () => {
    const port = new ProcessPort(), native = deferred(), cleanup = deferred(), entered = deferred();
    const context = {}, placement = {mode: 'headed-centered', bounds: {left: 1920, top: 100, width: 1280, height: 900}};
    let nativeCalls = 0, guardedCalls = 0;
    const browser = {close() {assert.equal(this, browser); nativeCalls++; return native.promise;}};
    const session = loadFactory(port)(browser, context, placement, {foreground: true});
    assert.equal(session.launchMode, 'macos-foreground-cdp');
    assert.equal(session.focusPolicy, 'foreground-authorized');
    assert.strictEqual(session.context, context); assert.strictEqual(session.windowPlacement, placement);
    session.useGuardedClose(function() {
      assert.equal(this, session); guardedCalls++; entered.resolve();
      return session.closeBrowserConnection().then(() => cleanup.promise);
    });
    const first = session.close(); await entered.promise;
    assertRouted(port); assert.equal(port.emit('SIGINT'), true); assert.equal(port.emit('SIGTERM'), true);
    assertRouted(port); assert.deepEqual(port.exits, []);
    assert.strictEqual(session.close(), first);
    native.resolve(); await native.promise;
    assertRouted(port); assert.deepEqual(port.exits, []);
    cleanup.resolve(); await first; await port.exitReady.promise;
    assertReleased(port); assert.deepEqual(port.exits, [130]);
    assert.equal(nativeCalls, 1); assert.equal(guardedCalls, 1);
    assert.strictEqual(session.close(), first);
  });

  test('actual guard composition retains routing during native and owned pending, then exact actor gone', options, async t => {
    const owner = await actor(t, true), port = new ProcessPort(), h = guardedFactory(owner, port);
    assert.equal(await actualGuard.getGuardedBrowserPid(h.session), owner.child.pid);
    const first = h.session.close(); first.catch(() => {});
    t.after(async () => {h.native.resolve(); if (!owner.closed) owner.child.send('exit-actor'); await Promise.allSettled([first]);});
    await h.entered.promise; assertRouted(port);
    assert.equal(port.emit('SIGINT'), true); assertRouted(port);
    assert.deepEqual(port.exits, []); assert.equal(owner.closed, false);
    h.native.resolve();
    await owner.wait(value => value.kind === 'actor-term', 'original guard TERM');
    assertRouted(port);
    assert.equal(port.emit('SIGTERM'), true);
    assert.deepEqual(port.exits, []); assert.equal(owner.closed, false);
    owner.child.send('exit-actor');
    await first; await port.exitReady.promise;
    assert.deepEqual(await owner.done, {code: 0, signal: null});
    assert.deepEqual(port.exits, [130]); assertReleased(port);
    assert.strictEqual(h.session.close(), first);
    assert.deepEqual(h.calls, {native: 1, cdp: 1, detach: 1});
    assert.equal(fs.existsSync(owner.profile), true);
  });

  test('original native5000 timeout remains same rejected receipt after exact cleanup and late fulfillment', options, async t => {
    const owner = await actor(t), port = new ProcessPort(), errors = [], h = guardedFactory(owner, port, errors);
    assert.equal(await actualGuard.getGuardedBrowserPid(h.session), owner.child.pid);
    const first = h.session.close(); first.catch(() => {});
    t.after(async () => {h.native.resolve(); await Promise.allSettled([first]);});
    await h.entered.promise; assertRouted(port);
    assert.equal(port.emit('SIGTERM'), true); assertRouted(port);
    assert.deepEqual(port.exits, []);
    let rejection;
    await assert.rejects(first, error => {
      rejection = error;
      assert.equal(error.code, 'NATIVE_CLOSE_TIMEOUT', 'Unexpected close receipt: ' + closeReceiptCodes(error));
      return true;
    });
    await port.exitReady.promise;
    assert.deepEqual(await owner.done, {code: 0, signal: null});
    assert.deepEqual(port.exits, [143]); assertReleased(port);
    assert.strictEqual(errors[0][1], rejection);
    h.native.resolve();
    assert.strictEqual(h.session.close(), first);
    await assert.rejects(h.session.close(), error => error === rejection);
    assert.equal(fs.existsSync(owner.profile), true);
    assert.deepEqual(h.calls, {native: 1, cdp: 1, detach: 1});
  });

  test('actual guard identity rejection preserves profile and actor, never releases listener before failure settles', options, async t => {
    const owner = await actor(t), port = new ProcessPort(), errors = [], h = guardedFactory(owner, port, errors);
    assert.equal(await actualGuard.getGuardedBrowserPid(h.session), owner.child.pid);
    const first = h.session.close(); first.catch(() => {});
    t.after(async () => {h.native.resolve(); await Promise.allSettled([first]);});
    await h.entered.promise; assertRouted(port);
    assert.equal(port.emit('SIGTERM'), true);
    const retained = owner.profile + '.retained-original';
    fs.renameSync(owner.profile, retained); owner.extraPaths.push(retained); fs.mkdirSync(owner.profile);
    h.native.resolve();
    let rejection;
    await assert.rejects(first, error => {rejection = error; return error.code === 'IDENTITY_CHANGED';});
    await port.exitReady.promise;
    assert.equal(owner.closed, false);
    assert.equal(owner.child.exitCode, null);
    assert.equal(owner.messages.some(value => value.kind === 'actor-term'), false);
    assert.equal(fs.existsSync(owner.profile), true); assert.equal(fs.existsSync(retained), true);
    assertReleased(port); assert.deepEqual(port.exits, [143]);
    assert.strictEqual(errors[0][1], rejection);
    await assert.rejects(h.session.close(), error => error === rejection);
    assert.deepEqual(h.calls, {native: 1, cdp: 1, detach: 1});
  });

  for (const stage of ['native', 'owned']) for (const signals of [
    ['SIGINT', 'SIGTERM', 'SIGINT'], ['SIGTERM', 'SIGINT', 'SIGTERM'],
  ]) {
    test('real mixed signals ' + signals.join('/') + ' at actual guard ' + stage + ' keep first exit and one cleanup', options, async t => {
      const owner = await actor(t, true);
      const worker = watchChild(fork(fixturePath, ['--helper-worker', '--owner-pid', String(owner.child.pid), '--owner-profile', owner.profile],
        {env: {...process.env, FLUENTREAD_SIGNAL_TEST_HELPER: helperPath, FLUENTREAD_SIGNAL_TEST_GUARD: guardPath},
          execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']}));
      t.after(async () => {if (!worker.closed) worker.child.kill('SIGKILL'); await worker.done;});
      const ready = await worker.wait(value => value.kind === 'worker-ready', 'actual worker ready');
      assert.equal(ready.pid, worker.child.pid);
      await worker.wait(value => value.kind === 'native-pending', 'original native pending');
      if (stage === 'owned') {
        worker.child.send('release-native');
        await owner.wait(value => value.kind === 'actor-term', 'actual owned cleanup TERM');
      }
      for (const [index, signal] of signals.entries()) {
        assert.equal(worker.child.kill(signal), true);
        await worker.wait(value => value.kind === 'signal-routed' && value.signal === signal &&
          worker.messages.filter(item => item.kind === 'signal-routed' && item.signal === signal).length >=
            signals.slice(0, index + 1).filter(item => item === signal).length, 'signal ' + index + ' routed');
        assert.equal(worker.closed, false); assert.equal(owner.closed, false);
      }
      if (stage === 'native') {
        worker.child.send('release-native');
        await owner.wait(value => value.kind === 'actor-term', 'owned pending after native release');
      }
      assert.equal(worker.closed, false); assert.equal(owner.closed, false);
      owner.child.send('exit-actor');
      assert.deepEqual(await owner.done, {code: 0, signal: null});
      assert.deepEqual(await worker.done, {code: signals[0] === 'SIGINT' ? 130 : 143, signal: null});
      assert.equal(owner.messages.filter(value => value.kind === 'actor-term').length, 1);
      assert.equal(owner.messages.filter(value => value.kind === 'actor-exit').length, 1);
      assert.equal(worker.messages.filter(value => value.kind === 'signal-routed').length, 3);
      assert.equal(worker.stderr, '');
      assert.equal(fs.existsSync(owner.profile), true);
    });
  }
}
