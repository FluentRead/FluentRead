import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {Script} from 'node:vm';
import ts from 'typescript';
import {describe, expect, it, vi} from 'vitest';
import {resolveNavigationItem, resolveRequestedSection} from '@/src/features/settings/model/navigation';

const PROJECT_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

describe('原生焦点事件观察器诊断端口（不启动浏览器）', () => {
    const {createFocusEventMonitor} = require(resolve(PROJECT_ROOT, 'scripts/testing/mac-focus-event-monitor.cjs'));
    const readyRecord = {kind: 'ready', pid: 72817, time: 1000, monotonicMs: 10};
    function monitorFixture(options: Record<string, unknown> = {}) {
        const child = Object.assign(new EventEmitter(), {pid: 72817, stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: Object.assign(new EventEmitter(), {end: vi.fn(() => {queueMicrotask(() => child.emit('close', 0, null));})}),
            kill: vi.fn((_signal: string) => {queueMicrotask(() => child.emit('close', null, _signal)); return true;})});
        const ports = {compile: vi.fn(async () => '/owned-temporary/observer'), spawn: vi.fn(() => child), cleanup: vi.fn(async () => {})};
        const monitor = createFocusEventMonitor(options, ports);
        const write = (record: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(record) + '\n'));
        return {child, ports, monitor, write};
    }
    async function drainMonitor() {for (let index = 0; index < 8; index++) await Promise.resolve();}
    it('必须收到已注册监听的准确进程 ready 才就绪，UTF-8 分块事件保留应用名称与两个时间', async () => {
        const event = vi.fn(), f = monitorFixture({onEvent: event}); await drainMonitor();
        let ready = false; void f.monitor.ready.then(() => {ready = true;}); expect(ready).toBe(false);
        f.write(readyRecord); await expect(f.monitor.ready).resolves.toEqual({monitorPid: 72817, time: 1000, monotonicMs: 10});
        const activation = {kind: 'activation', pid: 3456, name: '卡皮巴拉', time: 1100, monotonicMs: 20};
        const data = Buffer.from(JSON.stringify(activation) + '\n'); const offset = data.indexOf(Buffer.from('卡')) + 1;
        f.child.stdout.emit('data', data.subarray(0, offset)); expect(event).not.toHaveBeenCalled(); f.child.stdout.emit('data', data.subarray(offset));
        expect(event).toHaveBeenCalledWith(activation); expect(f.monitor.events).toEqual([activation]); expect(Object.isFrozen(f.monitor.events[0])).toBe(true);
        const stop = f.monitor.stop(); expect(f.monitor.stop()).toBe(stop); await stop; expect(f.child.stdin.end).toHaveBeenCalledWith('stop\n'); expect(f.child.kill).not.toHaveBeenCalled(); expect(f.ports.cleanup).toHaveBeenCalledOnce();
    });
    it('调用者识别自有 Edge 的短暂激活后永久失败，后续非 Edge 事件不能覆盖诊断', async () => {
        const unsafe = new Error('Owned Edge activated');
        const f = monitorFixture({onEvent: (event: {pid: number}) => {if (event.pid === 18812) throw unsafe;}}); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        f.write({kind: 'activation', pid: 18812, name: 'Microsoft Edge', time: 1100, monotonicMs: 20});
        f.write({kind: 'activation', pid: 44386, name: 'Google Chrome', time: 1200, monotonicMs: 30});
        expect(f.monitor.error).toBe(unsafe); expect(f.monitor.events.map((event: {pid: number}) => event.pid)).toEqual([18812, 44386]); await expect(f.monitor.stop()).rejects.toBe(unsafe);
    });
    it.each([{kind: 'ready', pid: 999, time: 1000, monotonicMs: 10}, {kind: 'activation', pid: -1, name: 'bad', time: 1000, monotonicMs: 10}, {kind: 'activation', pid: 7, name: null, time: 1000, monotonicMs: 10}, {kind: 'activation', pid: 7, name: 'bad', time: -1, monotonicMs: 10}, {kind: 'activation', pid: 7, name: 'bad', time: 1000, monotonicMs: -.5}, {kind: 'unknown', pid: 7, time: 1000, monotonicMs: 10}])('未就绪时拒绝不合法原生记录 %j', async record => {
        const f = monitorFixture(); await drainMonitor(); f.write(record); await expect(f.monitor.ready).rejects.toThrow(); expect(f.monitor.error).toBeTruthy(); await expect(f.monitor.stop()).rejects.toBe(f.monitor.error);
    });
    it('损坏 JSON、重复 ready 和单调时间倒退均永久失败，异常回调不掩盖首个原因', async () => {
        for (const invalid of ['json', 'duplicate', 'time']) {
            const f = monitorFixture({onError: () => {throw new Error('secondary');}}); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            if (invalid === 'json') f.child.stdout.emit('data', Buffer.from('broken\n'));
            else if (invalid === 'duplicate') f.write(readyRecord);
            else f.write({kind: 'activation', pid: 7, name: 'browser', time: 1200, monotonicMs: 9});
            const error = f.monitor.error; expect(error).toBeTruthy(); f.child.stderr.emit('data', Buffer.from('later diagnostic')); expect(f.monitor.error).toBe(error); await expect(f.monitor.stop()).rejects.toBe(error);
        }
    });
    it('超长未完成记录、进程错误和意外退出不会把观察链缺失称为焦点安全', async () => {
        for (const kind of ['buffer', 'error', 'exit']) {
            const f = monitorFixture(); await drainMonitor();
            if (kind === 'buffer') f.child.stdout.emit('data', Buffer.from('x'.repeat(65537)));
            else if (kind === 'error') f.child.emit('error', Error('spawn')); else f.child.emit('close', 0, null);
            await expect(f.monitor.ready).rejects.toThrow(); expect(f.monitor.error).toBeTruthy(); await expect(f.monitor.stop()).rejects.toBe(f.monitor.error);
        }
    });
    it('编译失败或编译期间停止不创建观察进程，清理只涉及编译器自己的临时输出', async () => {
        const failed = {compile: vi.fn(async () => {throw Error('compile failed');}), spawn: vi.fn(), cleanup: vi.fn(async () => {})};
        const first = createFocusEventMonitor({}, failed); await expect(first.ready).rejects.toThrow('compile failed'); await expect(first.stop()).rejects.toThrow('compile failed'); expect(failed.spawn).not.toHaveBeenCalled(); expect(failed.cleanup).toHaveBeenCalledOnce();
        let finish!: (value: string) => void;
        const ports = {compile: vi.fn(() => new Promise<string>(resolve => {finish = resolve;})), spawn: vi.fn(), cleanup: vi.fn(async () => {})};
        const second = createFocusEventMonitor({}, ports); await drainMonitor(); const stop = second.stop(); finish('/owned-observer'); await expect(stop).rejects.toThrow('stopped before ready'); await expect(second.ready).rejects.toThrow('stopped before ready'); expect(ports.spawn).not.toHaveBeenCalled(); expect(ports.cleanup).toHaveBeenCalledOnce();
    });
    it('ready 超时只终止已 spawn 的观察子进程，不运行应用激活命令', async () => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture({readinessTimeoutMs: 20}); await drainMonitor(); await vi.advanceTimersByTimeAsync(20); await expect(f.monitor.ready).rejects.toThrow('did not become ready'); await expect(f.monitor.stop()).rejects.toThrow('did not become ready'); expect(f.child.stdin.end).toHaveBeenCalledOnce(); expect(f.ports.cleanup).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers();}
    });
    it('优雅停止失败仅对拥有的子进程逐步终止，缺少关闭回执保留输出并报告', async () => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready; f.child.stdin.end.mockImplementation(() => {}); f.child.kill.mockImplementation(() => true);
            const stop = f.monitor.stop(); const rejected = expect(stop).rejects.toThrow('Owned observer did not close'); await vi.advanceTimersByTimeAsync(3500); await rejected;
            expect(f.child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']); expect(f.ports.cleanup).not.toHaveBeenCalled();
        } finally {vi.useRealTimers();}
    });
    it.each([{code: 3, signal: null}, {code: null, signal: 'SIGTERM'}])('停止期间非零退出或外部信号不能被当作成功：%j', async ({code, signal}) => {
        const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        f.child.stdin.end.mockImplementation(() => {queueMicrotask(() => f.child.emit('close', code, signal));});
        await expect(f.monitor.stop()).rejects.toMatchObject({code: 'FOCUS_OBSERVER_EXIT'});
        expect(f.monitor.error).toMatchObject({code: 'FOCUS_OBSERVER_EXIT'});
        expect(f.child.kill).not.toHaveBeenCalled(); expect(f.ports.cleanup).toHaveBeenCalledOnce();
    });
    it.each([Buffer.from('{"kind":"activation"'), Buffer.from([0xe5, 0x8d])])('关闭时尾部残缺行或 UTF-8 必须失败', async data => {
        const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        f.child.stdout.emit('data', data);
        await expect(f.monitor.stop()).rejects.toMatchObject({code: 'FOCUS_OBSERVER_PROTOCOL'});
        expect(f.ports.cleanup).toHaveBeenCalledOnce();
    });
    it('JSON 字符串内无效 UTF-8 即使被替换后可解析也必须失败', async () => {
        const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        f.child.stdout.emit('data', Buffer.concat([
            Buffer.from('{"kind":"activation","pid":123,"name":"'), Buffer.from([0xe5, 0x8d]),
            Buffer.from('","time":1100,"monotonicMs":20}\n'),
        ]));
        await expect(f.monitor.stop()).rejects.toMatchObject({code: 'FOCUS_OBSERVER_PROTOCOL'});
        expect(f.monitor.events).toEqual([]);
    });
    it('清理失败不覆盖最初监控失败，并在无先前错误时保留清理错误', async () => {
        for (const priorFailure of [true, false]) {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            const cleanupError = new Error('cleanup failed'); f.ports.cleanup.mockRejectedValue(cleanupError);
            if (priorFailure) f.child.stderr.emit('data', Buffer.from('first failure'));
            const first = f.monitor.error;
            await expect(f.monitor.stop()).rejects.toBe(priorFailure ? first : cleanupError);
            expect(f.monitor.error).toBe(priorFailure ? first : cleanupError);
        }
    });
    it('无法关闭时保留首次监控错误且不清除观察器临时文件', async () => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            f.child.stderr.emit('data', Buffer.from('first failure')); const first = f.monitor.error;
            f.child.stdin.end.mockImplementation(() => {}); f.child.kill.mockImplementation(() => true);
            const stop = f.monitor.stop(), rejected = expect(stop).rejects.toBe(first);
            await vi.advanceTimersByTimeAsync(3500); await rejected;
            expect(f.ports.cleanup).not.toHaveBeenCalled();
        } finally {vi.useRealTimers();}
    });
    it.each([true, false])('向自有子进程发信号抛错时保留首错并在未关闭时保留临时文件（已有错误：%s）', async priorFailure => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            if (priorFailure) f.child.stderr.emit('data', Buffer.from('first failure'));
            const signalError = new Error('signal failed');
            const first = f.monitor.error || signalError;
            f.child.stdin.end.mockImplementation(() => {}); f.child.kill.mockImplementation(() => {throw signalError;});
            const stop = f.monitor.stop(), rejected = expect(stop).rejects.toBe(first);
            await vi.advanceTimersByTimeAsync(3500); await rejected;
            expect(f.monitor.error).toBe(first); expect(f.ports.cleanup).not.toHaveBeenCalled();
        } finally {vi.useRealTimers();}
    });
    it('停止命令发送失败时即使进程随后正常退出也不得报告监控成功', async () => {
        const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        const failure = new Error('stdin failed');
        f.child.stdin.end.mockImplementation(() => {queueMicrotask(() => f.child.emit('close', 0, null)); throw failure;});
        await expect(f.monitor.stop()).rejects.toBe(failure); expect(f.ports.cleanup).toHaveBeenCalledOnce();
    });
    it('未 ready 时 onError 重入 stop 共用同一个 promise 且只清理一次', async () => {
        let nested: Promise<unknown> | undefined;
        const f = monitorFixture({onError: () => {nested = f.monitor.stop();}}); await drainMonitor();
        const stop = f.monitor.stop(); await expect(stop).rejects.toMatchObject({code: 'FOCUS_OBSERVER_STOPPED'});
        expect(nested).toBe(stop); expect(f.ports.cleanup).toHaveBeenCalledOnce();
    });
    it.each(['SIGTERM', 'SIGKILL'])('只有通过自有子进程句柄实际发送的 %s 归为受控强制停止，仍不能证明监控完整', async expected => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            f.child.stdin.end.mockImplementation(() => {});
            f.child.kill.mockImplementation(signal => {
                if (signal === expected) queueMicrotask(() => f.child.emit('close', null, signal));
                return true;
            });
            const stop = f.monitor.stop();
            const rejected = expect(stop).rejects.toMatchObject({code: 'FOCUS_OBSERVER_FORCED_STOP'});
            await vi.advanceTimersByTimeAsync(expected === 'SIGTERM' ? 1000 : 2000); await rejected;
            expect(f.child.kill.mock.calls.map(call => call[0])).toEqual(expected === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
            expect(f.ports.cleanup).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers();}
    });
    it('发送信号返回失败时不能将随后同名信号归因于本进程', async () => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            f.child.stdin.end.mockImplementation(() => {});
            f.child.kill.mockImplementation(signal => {queueMicrotask(() => f.child.emit('close', null, signal)); return false;});
            const stop = f.monitor.stop(), rejected = expect(stop).rejects.toMatchObject({code: 'FOCUS_OBSERVER_EXIT'});
            await vi.advanceTimersByTimeAsync(1000); await rejected;
        } finally {vi.useRealTimers();}
    });
    it('观察进程已退出但输出流尚未关闭时，等待 close 且不向可能复用的 PID 发送信号', async () => {
        vi.useFakeTimers();
        try {
            const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
            f.child.stdin.end.mockImplementation(() => {});
            const stop = f.monitor.stop();
            f.child.emit('exit', 0, null);
            await vi.advanceTimersByTimeAsync(2000);
            expect(f.child.kill).not.toHaveBeenCalled();
            f.child.emit('close', 0, null); await stop;
            expect(f.ports.cleanup).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers();}
    });
    it('退出事件先于 stop、close 晚于 stop 时仍按意外退出失败', async () => {
        const f = monitorFixture(); await drainMonitor(); f.write(readyRecord); await f.monitor.ready;
        f.child.emit('exit', 0, null);
        await expect(f.monitor.stop()).rejects.toMatchObject({code: 'FOCUS_OBSERVER_EXIT'});
        expect(f.child.kill).not.toHaveBeenCalled();
    });
    it('Swift 只读取 NSWorkspace 通知，不启动、激活或关闭用户应用；helper 不改变现有启动路径', () => {
        const swift = readFileSync(resolve(PROJECT_ROOT, 'scripts/testing/mac-focus-event-observer.swift'), 'utf8');
        expect(swift).toContain('NSWorkspace.didActivateApplicationNotification'); expect(swift.indexOf('center.addObserver')).toBeLessThan(swift.indexOf('emit(ready)'));
        expect(swift).not.toMatch(/activateIgnoringOtherApps|launchApplication|openApplication|\.terminate\(/u);
        const helper = readFileSync(resolve(PROJECT_ROOT, 'scripts/testing/focus-safe-browser.cjs'), 'utf8'); expect(helper).toContain('startFocusEventMonitor,');
        expect(helper).toContain("Target.createTarget', { url: markerUrl, background: true }");
    });
});

type CacheTraceRecord = Record<string, unknown>;
type CacheTraceSession = {send: (...args: unknown[]) => unknown};
type CacheTraceBrowser = {newBrowserCDPSession: (...args: unknown[]) => Promise<CacheTraceSession>};
type CacheTrace = {
    setCase: (name: string) => void;
    observeActivation: (event: {pid: number; name: string; time: number; monotonicMs: number}) => void;
    bindPage: (page: object) => void;
    pageIdentity: (page: object) => Record<string, unknown>;
    action: <T>(name: string, invoke: () => T | Promise<T>, page?: object) => Promise<T>;
    instrumentBrowser: (browser: CacheTraceBrowser) => CacheTraceBrowser;
};
const CACHE_RECOVERY_CLI = 'scripts/testing/run-cache-clear-recovery-test.cjs';
function cacheTraceFixture() {
    const source = readScript(CACHE_RECOVERY_CLI);
    const ast = ts.createSourceFile(CACHE_RECOVERY_CLI, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createCacheFocusTrace');
    if (!declaration) throw Error('Missing actual cache CLI trace factory');
    const factory = new Script(`${declaration.getText(ast)}; createCacheFocusTrace;`).runInNewContext({performance}) as (ports: {
        records: CacheTraceRecord[]; errors: CacheTraceRecord[]; readForeground: () => Promise<unknown>;
        getBrowserPid: () => number; getFocusFailure: () => Error | undefined;
        onOwnedActivation: (error: Error) => void; onObservationFailure: (error: Error) => void;
    }) => CacheTrace;
    const records: CacheTraceRecord[] = [], errors: CacheTraceRecord[] = [];
    let failure: Error | undefined;
    const readForeground = vi.fn(async (): Promise<unknown> => ({pid: 1, name: 'Editor', privateValue: 'PRIVATE_FOREGROUND'}));
    const trace = factory({records, errors, readForeground, getBrowserPid: () => 42, getFocusFailure: () => failure,
        onOwnedActivation: error => {failure ||= error;}, onObservationFailure: error => {failure ||= error;}});
    const send = vi.fn(function (this: CacheTraceSession, ...args: unknown[]): unknown {
        const [method] = args;
        if (method === 'Target.createTarget') return Promise.resolve({targetId: 'owned-target', secret: 'PRIVATE_RESULT'});
        if (method === 'Browser.getWindowForTarget') return Promise.resolve({windowId: 7, bounds: {left: 1500, top: 30, width: 1440, height: 1000, windowState: 'normal', secret: 'PRIVATE_BOUNDS'}});
        if (method === 'Browser.getWindowBounds') return Promise.resolve({bounds: {left: 1500, top: 30, width: 1440, height: 1000}});
        return Promise.resolve({success: true});
    });
    const cdp = {send};
    const nativeSession = vi.fn(async () => cdp);
    const browser = {newBrowserCDPSession: nativeSession};
    trace.instrumentBrowser(browser);
    return {trace, records, errors, readForeground, send, cdp, browser, nativeSession, failure: () => failure};
}

// Execute the complete CLI in a VM; ports model only the first normal case and
// stop at the next newPage boundary. No browser, native app or real I/O is used.
async function probeCacheRecoveryCli(mode: 'native-reject' | 'activation' | 'unavailable' | 'diagnostics-failure' = 'native-reject') {
    const filename = resolve(PROJECT_ROOT, CACHE_RECOVERY_CLI), helperPath = '/virtual/cache-focus-helper.cjs';
    const rawFailure = new Error('original native newPage failure');
    const runtimeFailure = new Error('original runtime diagnostics failure');
    const calls: string[] = [], logs: unknown[][] = [], capturedErrors: unknown[] = [];
    const snapshots: Record<string, unknown>[] = [];
    let foreground: unknown = {pid: 1, name: 'Editor'}, target = 0;
    let onEvent!: (event: {pid: number; name: string; time: number; monotonicMs: number}) => void;
    let finish!: () => void;
    const complete = new Promise<void>(done => {finish = done;});
    const monitor = {ready: Promise.resolve(), events: [] as {pid: number; name: string; time: number; monotonicMs: number}[], error: undefined,
        stop: vi.fn(async () => {calls.push('monitor.stop');})};
    const nativeSend = vi.fn(function (method: string, params?: Record<string, unknown>) {
        calls.push(method);
        if (method === 'Target.createTarget') {
            target++;
            if (target === 5) return Promise.reject(rawFailure);
            return Promise.resolve({targetId: `owned-${target}`, privateValue: 'PRIVATE_CDP_RESULT'});
        }
        if (method === 'Browser.getWindowForTarget') return Promise.resolve({windowId: 7, bounds: {left: 1500, top: 30, width: 1440, height: 1000, windowState: 'normal'}});
        if (method === 'Browser.getWindowBounds') return Promise.resolve({bounds: {left: 1500, top: 30, width: 1440, height: 1000}});
        if (method === 'Browser.setWindowBounds') expect(params?.bounds).toBeTruthy();
        return Promise.resolve({success: true});
    });
    const browser = {newBrowserCDPSession: async () => ({send: nativeSend})};
    const chromium = {connectOverCDP: vi.fn(async () => browser)};
    let cdp!: Awaited<ReturnType<typeof browser.newBrowserCDPSession>>;
    const makeTarget = async () => {
        cdp = await browser.newBrowserCDPSession();
        const result = await cdp.send('Target.createTarget', {url: 'PRIVATE_URL', background: true}) as {targetId: string};
        await cdp.send('Browser.getWindowForTarget', {targetId: result.targetId});
        await cdp.send('Browser.getWindowBounds', {windowId: 7});
        await cdp.send('Browser.setWindowBounds', {windowId: 7, bounds: {left: 1500, top: 30, width: 1440, height: 1000}});
        return result.targetId;
    };
    const probe = {receipts: [{type: 'clearTranslationCache', invalidationPending: false}], requests: [], holds: [], longTimers: []};
    function pagePort() {
        const locator = {count: async () => 1, isVisible: async () => true, waitFor: async () => {}, click: async () => {},
            filter: () => locator, screenshot: async () => {
                calls.push('screenshot.component');
                if (mode === 'activation') {
                    const event = {pid: 42, name: 'Owned browser', time: Date.now(), monotonicMs: 100};
                    monitor.events.push(event);onEvent(event);
                }
                return Buffer.from('image');
            }, innerText: async () => 'failure DOM', getAttribute: async () => 'status'};
        return {on: () => {}, addInitScript: async () => {}, goto: async () => {}, locator: () => locator,
            waitForFunction: async () => {}, evaluate: async () => probe, isClosed: () => false,
            screenshot: async () => {calls.push('screenshot.page');return Buffer.from('image');}, close: async () => {calls.push('page.close');}};
    }
    const worker = {url: () => 'chrome-extension://owned/background.js', evaluate: async () => ({entries: 0, totals: null})};
    const context = {serviceWorkers: () => [worker]};
    const session = {context, launchMode: 'macos-background-cdp', focusPolicy: 'launchservices-no-foreground',
        windowPlacement: {mode: 'background-visible-no-focus', browserFrontmost: false},
        close: async () => {calls.push('owned.close');await cdp.send('Target.closeTarget', {targetId: 'owned-1'});}};
    const helper = {
        startFocusEventMonitor: (options: {onEvent: typeof onEvent}) => {onEvent = options.onEvent;return monitor;},
        queryMacFrontmostApplication: async () => foreground,
        launchFocusSafePersistentContext: async (options: {chromium: typeof chromium}) => {
            expect(options.chromium).toBe(chromium);await chromium.connectOverCDP();await makeTarget();
            if (mode === 'unavailable') foreground = null;
            return session;
        },
        newPageWithoutForeground: async () => {await makeTarget();return pagePort();},
        activateExtensionTabWithoutForeground: async () => {},
    };
    const diagnostics = {setPhase: () => {}, attachPage: async () => {}, start: async () => {}, setExtensionId: () => {},
        flush: async () => {if (mode === 'diagnostics-failure') throw runtimeFailure;}, snapshot: () => ({errors: [], warnings: []}),
        stop: async () => {calls.push('diagnostics.stop');}, assertClean: () => {}};
    const fakeFs = {mkdirSync: () => {}, mkdtempSync: () => '/tmp/owned-cache-profile', rmSync: () => {calls.push('profile.remove');}, rmdirSync: () => {},
        readFileSync: (file: string) => file.endsWith('manifest.json') ? JSON.stringify({version: 'fixture', action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}) : Buffer.from('PRIVATE_SOURCE'),
        readdirSync: () => [{name: 'manifest.json', isDirectory: () => false}],
        writeFileSync: (file: string, value: string) => {if (file.endsWith('/report.json')) snapshots.push(JSON.parse(value));}};
    const server = {listening: false, once: () => {}, listen: (_port: number, _host: string, ready: () => void) => {server.listening = true;ready();},
        address: () => ({port: 49152}), closeAllConnections: () => {}, close: (closed: () => void) => {server.listening = false;closed();}};
    const cliModule = {exports: {}};
    const cliRequire = Object.assign((specifier: string): unknown => {
        if (specifier === 'node:fs') return fakeFs;
        if (specifier === 'node:os') return {tmpdir: () => '/tmp'};
        if (specifier === 'node:http') return {createServer: () => server};
        if (specifier === './owned-browser-close.cjs') return {guardBrowserClose: () => session, getGuardedBrowserPid: async () => 42};
        if (specifier === '/virtual/diagnostics.cjs') return {createRuntimeDiagnostics: () => diagnostics};
        if (specifier === '/virtual/packages/playwright') return {chromium};
        if (specifier === helperPath) return helper;
        if (['node:path', 'node:crypto', 'node:assert/strict'].includes(specifier)) return require(specifier);
        throw Error(`Unexpected offline CLI port ${specifier}`);
    }, {main: cliModule});
    const cliProcess = {argv: [process.execPath, filename, '--extension-dir', '/virtual/chrome-mv3', '--artifacts-dir', '/virtual/evidence',
        '--runtime-diagnostics', '/virtual/diagnostics.cjs', '--playwright-root', '/virtual/packages', '--focus-safe-helper', helperPath], exitCode: 0};
    new Script(readScript(CACHE_RECOVERY_CLI), {filename}).runInNewContext({require: cliRequire, module: cliModule, exports: cliModule.exports,
        __dirname: dirname(filename), __filename: filename, process: cliProcess, performance, Buffer, URL,
        console: {error: (...args: unknown[]) => {capturedErrors.push(...args);}, log: (...args: unknown[]) => {logs.push(args);if (args.length === 1 && String(args[0]).startsWith('{')) finish();}}}, {timeout: 1000});
    await complete;
    return {report: snapshots.at(-1)!, calls, logs, capturedErrors, rawFailure, runtimeFailure, nativeSend, exitCode: cliProcess.exitCode};
}

describe('缓存恢复 CLI 焦点时序诊断（完整离线端口，无浏览器）', () => {
    it('精确白名单保留参数、接收者和原生对象身份，记录 case/target/window/bounds 而不记录消息正文', async () => {
        const f = cacheTraceFixture();
        expect(f.trace.instrumentBrowser(f.browser)).toBe(f.browser);
        const cdp = await f.browser.newBrowserCDPSession();expect(cdp).toBe(f.cdp);
        f.trace.setCase('case-normal');
        const params = {url: 'PRIVATE_URL', background: true, config: 'PRIVATE_CONFIG'};
        const created = await cdp.send('Target.createTarget', params) as {targetId: string};
        expect(f.send).toHaveBeenCalledWith('Target.createTarget', params);expect(f.send.mock.contexts[0]).toBe(cdp);
        await cdp.send('Browser.getWindowForTarget', {targetId: created.targetId});
        await cdp.send('Browser.getWindowBounds', {windowId: 7});
        await cdp.send('Browser.setWindowBounds', {windowId: 7, bounds: {left: 1600, top: 40, width: 1400, height: 900, privateValue: 'PRIVATE_REQUEST'}});
        const page = {};f.trace.bindPage(page);const result = {privateMessage: 'PRIVATE_ACTION_RESULT'};
        expect(await f.trace.action('readProbe', () => result, page)).toBe(result);
        const untouched = Promise.resolve({body: 'PRIVATE_UNLISTED'});f.send.mockReturnValueOnce(untouched);
        expect(cdp.send('Runtime.evaluate', {expression: 'PRIVATE_EXPRESSION'})).toBe(untouched);
        expect(f.trace.pageIdentity(page)).toEqual({targetId: 'owned-target', windowId: 7, bounds: {left: 1500, top: 30, width: 1440, height: 1000}});
        const completed = f.records.filter(record => record.phase === 'completed');expect(completed).toHaveLength(5);
        expect(completed.at(-1)).toMatchObject({scope: 'action', name: 'readProbe', case: 'case-normal', targetId: 'owned-target', windowId: 7,
            browserPid: 42, foreground: {pid: 1, name: 'Editor', sampledAt: {time: expect.any(Number), monotonicMs: expect.any(Number)}}});
        expect(completed[3]).toMatchObject({request: {windowId: 7, bounds: {left: 1600, top: 40, width: 1400, height: 900}}});
        expect(JSON.stringify(f.records)).not.toContain('PRIVATE');expect(f.errors).toEqual([]);
        expect(f.records.map(record => record.sequence)).toEqual(Array.from({length: 10}, (_, index) => index + 1));
    });
    it('CDP 原始拒绝保留身份，原生激活关联尚未完成调用并永久阻止后续动作，允许自建 target 清理', async () => {
        const f = cacheTraceFixture(), cdp = await f.browser.newBrowserCDPSession();await cdp.send('Target.createTarget');
        const original = new Error('PRIVATE_NATIVE_REJECTION');
        f.send.mockImplementationOnce(() => {f.trace.observeActivation({pid: 42, name: 'Owned', time: 200, monotonicMs: 100});return Promise.reject(original);});
        await expect(cdp.send('Browser.setWindowBounds', {windowId: 7, bounds: {left: 5}})).rejects.toBe(original);
        const failure = f.failure();expect(failure).toBeTruthy();
        f.trace.observeActivation({pid: 1, name: 'Editor', time: 201, monotonicMs: 101});
        const invoke = vi.fn();
        for (const name of ['screenshot.component', 'screenshot.page', 'readProbe', 'page.close', 'newPage']) await expect(f.trace.action(name, invoke)).rejects.toBe(failure);
        await expect(cdp.send('Target.createTarget', {url: 'PRIVATE_URL'})).rejects.toBe(failure);
        await expect(cdp.send('Target.closeTarget', {targetId: 'not-owned'})).rejects.toBe(failure);
        expect(invoke).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(2);
        await expect(cdp.send('Target.closeTarget', {targetId: 'owned-target'})).resolves.toEqual({success: true});
        expect(f.records.find(record => record.scope === 'native')).toMatchObject({activeOperations: [2], case: 'bootstrap'});
        expect(f.records.filter(record => record.phase === 'rejected')).toEqual([expect.objectContaining({name: 'Browser.setWindowBounds', errorName: 'Error'})]);
        expect(JSON.stringify(f.records)).not.toContain('PRIVATE_NATIVE_REJECTION');expect(f.errors).toEqual([]);
    });
    it.each(['null', 'reject'])('前置前台采样 %s 永久拦截 mutator，后置失败保留原始成功结果和拒绝', async unavailable => {
        const f = cacheTraceFixture(), cdp = await f.browser.newBrowserCDPSession();await cdp.send('Target.createTarget');
        const originalResult = {windowId: 7};f.send.mockReturnValueOnce(Promise.resolve(originalResult));
        f.readForeground.mockResolvedValueOnce({pid: 1, name: 'Editor'});
        if (unavailable === 'null') f.readForeground.mockResolvedValueOnce(null);else f.readForeground.mockRejectedValueOnce(new Error('PRIVATE_SAMPLE_ERROR'));
        expect(await cdp.send('Browser.getWindowForTarget', {targetId: 'owned-target'})).toBe(originalResult);
        const failure = f.failure();expect(failure?.message).toContain('Foreground trace observation unavailable');
        await expect(cdp.send('Target.createTarget')).rejects.toBe(failure);
        await expect(cdp.send('Browser.setWindowBounds', {windowId: 7, bounds: {left: 1}})).rejects.toBe(failure);
        expect(f.send).toHaveBeenCalledTimes(2);
        await cdp.send('Target.closeTarget', {targetId: 'owned-target'});expect(f.send).toHaveBeenCalledTimes(3);
        expect(f.errors).toHaveLength(1);expect(JSON.stringify(f.records)).not.toContain('PRIVATE_SAMPLE_ERROR');
        const before = cacheTraceFixture(), beforeCdp = await before.browser.newBrowserCDPSession();before.readForeground.mockResolvedValue(null);
        await expect(beforeCdp.send('Target.createTarget')).rejects.toThrow('Foreground trace observation unavailable');
        await expect(beforeCdp.send('Browser.setWindowBounds', {windowId: 7})).rejects.toBe(before.failure());expect(before.send).not.toHaveBeenCalled();
        const rejected = cacheTraceFixture(), rejectedCdp = await rejected.browser.newBrowserCDPSession(), nativeError = new Error('original CDP error');
        rejected.send.mockRejectedValueOnce(nativeError);rejected.readForeground.mockResolvedValueOnce({pid: 1}).mockResolvedValueOnce(null);
        await expect(rejectedCdp.send('Target.createTarget')).rejects.toBe(nativeError);expect(rejected.failure()).toBeTruthy();
    });
    it('完整 CLI 在导航前安装 trace，保持 case/动作/CDP 顺序和原始失败元数据', async () => {
        const f = await probeCacheRecoveryCli();expect(f.exitCode).toBe(1);expect(f.capturedErrors[0]).toBe(f.rawFailure);
        expect(f.report.failure).toBe(f.rawFailure.stack);expect(f.report.ok).toBe(false);
        expect(f.report.cases).toEqual([expect.objectContaining({name: 'options-normal-clear', passed: true})]);
        const trace = f.report.focusTrace as CacheTraceRecord[];
        expect(trace[0]).toMatchObject({scope: 'cdp', name: 'Target.createTarget', phase: 'started', case: 'bootstrap', browserPid: null});
        expect(trace.filter(record => record.scope === 'action' && record.case === 'options-normal-clear' && record.phase === 'started').map(record => record.name))
            .toEqual(['newPage', 'readProbe', 'screenshot.component', 'screenshot.page', 'page.close']);
        expect(trace.find(record => record.scope === 'action' && record.name === 'newPage' && record.case === 'options-normal-clear' && record.phase === 'completed'))
            .toMatchObject({targetId: 'owned-4', windowId: 7, bounds: {left: 1500, top: 30, width: 1440, height: 1000}});
        expect(trace.filter(record => record.phase === 'rejected').map(record => record.name)).toEqual(['Target.createTarget', 'newPage']);
        expect(f.report.focusTraceErrors).toEqual([]);expect(JSON.stringify(trace)).not.toContain('PRIVATE');
        expect(f.calls).toContain('owned.close');expect(f.report.profileRemoved).toBe(true);
        expect(f.report.runtimeDiagnostics).toEqual({errors: [], warnings: []});
    });
    it('完整 CLI 截图中观察激活后不再截图/读 probe/关页/建页，只保留 owned cleanup 与原始事件', async () => {
        const f = await probeCacheRecoveryCli('activation');const index = f.calls.indexOf('screenshot.component');
        expect(f.calls.slice(index + 1)).toEqual(['diagnostics.stop', 'owned.close', 'Target.closeTarget', 'monitor.stop', 'profile.remove']);
        expect(f.report.cases).toEqual([]);expect(f.report.focusEvents).toMatchObject({browserActivations: [{pid: 42}]});
        expect(f.report.failure).toContain('Owned test browser became frontmost');expect(f.report.failureCaptureError).toBe(f.report.failure);
        const trace = f.report.focusTrace as CacheTraceRecord[];
        expect(trace.find(record => record.scope === 'native')).toMatchObject({case: 'options-normal-clear', activeOperations: [expect.any(Number)]});
        expect(trace.filter(record => record.phase === 'completed' && record.name === 'Target.closeTarget')).toHaveLength(1);
        expect(f.report.profileRemoved).toBe(true);
    });
    it('完整 CLI 观测不可用在新页前停下，runtime diagnostics 失败独立保留且清理不被 trace 阻断', async () => {
        const f = await probeCacheRecoveryCli('unavailable');expect(f.calls.filter(call => call === 'Target.createTarget')).toHaveLength(1);
        expect(f.report.failure).toContain('Foreground trace observation unavailable');expect(f.report.focusTraceErrors).toHaveLength(3);
        expect(f.report.cleanupErrors).toEqual(expect.arrayContaining([expect.objectContaining({label: 'focus-trace'})]));expect(f.report.profileRemoved).toBe(true);
        const diagnostic = await probeCacheRecoveryCli('diagnostics-failure');expect(diagnostic.report.failure).toBe(diagnostic.rawFailure.stack);
        expect(diagnostic.report.cleanupErrors).toEqual([expect.objectContaining({label: 'runtime-diagnostics', error: diagnostic.runtimeFailure.stack})]);
        expect(diagnostic.calls).toContain('owned.close');expect(diagnostic.calls).toContain('diagnostics.stop');expect(diagnostic.report.profileRemoved).toBe(true);
    });
});

describe('后台翻译夹具资源隔离', () => {
    it('保留扩展相对资源，仅把翻译与外部网络交给本地夹具', async () => {
        const {installTranslationFixtureOnWorker} = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs'));
        const nativeFetch = vi.fn(async (_input: unknown, _init?: unknown) => ({ok: true}));
        vi.stubGlobal('fetch', nativeFetch);
        vi.stubGlobal('location', {href: 'chrome-extension://fixture/background.js'});
        vi.stubGlobal('__fluentReadFullPageFixtureFetchInstalled', false);
        const worker = {evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args)};
        const urls = {translationUrl: 'http://127.0.0.1:1234/translate', blockedUrl: 'http://127.0.0.1:1234/blocked'};
        try {
            await installTranslationFixtureOnWorker(worker, urls);
            const installed = globalThis.fetch;
            await fetch('icon/16.png');
            expect(nativeFetch).toHaveBeenLastCalledWith('icon/16.png', undefined);
            await fetch('chrome-extension://fixture/icon/32.png');
            expect(nativeFetch).toHaveBeenLastCalledWith('chrome-extension://fixture/icon/32.png', undefined);
            const init = {method: 'POST', body: '["source"]'};
            await fetch('https://edge.microsoft.com/translate/translatetext', init);
            expect(nativeFetch).toHaveBeenLastCalledWith(urls.translationUrl, init);
            await fetch('https://external.example/resource');
            expect(nativeFetch).toHaveBeenLastCalledWith(urls.blockedUrl + '?url=https%3A%2F%2Fexternal.example%2Fresource', {method: 'GET'});
            await installTranslationFixtureOnWorker(worker, urls);
            expect(globalThis.fetch).toBe(installed);
        } finally {vi.unstubAllGlobals();}
    });
});
const FOCUS_SAFE_SCRIPTS = [
    'scripts/testing/run-manga-entry-ui-test.cjs',
    'scripts/testing/run-manga-translation-test.cjs',
    'scripts/testing/run-vocabulary-reencounter-test.cjs',
    'scripts/testing/run-sentence-highlight-responsiveness.cjs',
    'scripts/run-cache-settings-test.cjs',
    'scripts/run-selection-trigger-test.cjs',
    'scripts/run-full-page-translation-test.cjs',
    'scripts/run-video-subtitle-fixture-test.cjs',
    'scripts/run-document-translation-test.cjs',
    'scripts/testing/run-settings-center-ui-test.cjs',
    'scripts/testing/run-lazy-options-ui-test.cjs',
    'scripts/testing/run-popup-startup-ui-test.cjs',
    'scripts/testing/run-startup-performance.cjs',
    'scripts/testing/run-ort-runtime-smoke.cjs',
    'scripts/testing/run-loading-motion-ui-test.cjs',
    'scripts/testing/run-translation-style-ui-test.cjs',
    'scripts/testing/run-service-catalog-ui-test.cjs',
    'scripts/testing/run-service-library-ui-test.cjs',
    'scripts/run-privacy-boundary-test.cjs',
    'scripts/run-site-translation-test.cjs',
    'scripts/run-userscript-smoke-test.cjs',
    'scripts/run-video-subtitle-test.cjs',
    'scripts/run-video-performance-test.cjs',
    'scripts/run-x-subtitle-sync-test.cjs',
];

const ACTIVATED_EXTENSION_TAB_SCRIPTS = FOCUS_SAFE_SCRIPTS.filter(
    (path) => ![
        'scripts/testing/run-vocabulary-reencounter-test.cjs',
        'scripts/run-document-translation-test.cjs',
        'scripts/testing/run-settings-center-ui-test.cjs',
        'scripts/testing/run-lazy-options-ui-test.cjs',
        'scripts/testing/run-popup-startup-ui-test.cjs',
        'scripts/testing/run-startup-performance.cjs',
        'scripts/testing/run-ort-runtime-smoke.cjs',
        'scripts/testing/run-loading-motion-ui-test.cjs',
        'scripts/testing/run-service-catalog-ui-test.cjs',
        'scripts/testing/run-service-library-ui-test.cjs',
        'scripts/run-userscript-smoke-test.cjs',
    ].includes(path),
);

const RUNNER_CLI_CASES = [
    {
        path: 'scripts/run-userscript-smoke-test.cjs',
        requiredArgs: [
            '--artifact', '.output/userscript/fluent-read.user.js',
            '--playwright-root', '/tmp/playwright-runtime',
            '--artifacts-dir', '/tmp/userscript-artifacts',
        ],
    },
    {
        path: 'scripts/run-video-subtitle-test.cjs',
        requiredArgs: ['--playwright-root', '/tmp/playwright-runtime'],
    },
    {
        path: 'scripts/run-video-performance-test.cjs',
        requiredArgs: ['--playwright-root', '/tmp/playwright-runtime'],
    },
];

const BUNDLED_HELPER_CLI_PATHS = [
    'scripts/run-userscript-smoke-test.cjs',
    'scripts/run-video-performance-test.cjs',
];
const BUNDLED_FOCUS_SAFE_HELPER = resolve(PROJECT_ROOT, 'scripts/testing/focus-safe-browser.cjs');
const FOCUS_SAFE_INTERFACES = [
    'launchFocusSafePersistentContext', 'newPageWithoutForeground', 'activateExtensionTabWithoutForeground',
] as const;
const LAUNCH_BOUNDARY_ERROR = 'focus-safety CLI probe stopped at the browser launch boundary';
type FocusSafeCliSelection = {
    extraArgs: string[];
    env: Record<string, string>;
    helperPath: string;
    helperExists: boolean;
};

function readScript(path: string): string {
    return readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
}

// Run the unmodified public CommonJS CLI entrypoint. Every external I/O port is
// replaced; launch ports record the selected branch and stop before any browser.
// In particular, do not extract main() with a source substring or export it here.
async function probeFocusSafeCli(
    runner: (typeof RUNNER_CLI_CASES)[number],
    extraArgs: string[],
    env: Record<string, string>,
    helperPath: string,
    helperExists: boolean,
    missingInterface?: (typeof FOCUS_SAFE_INTERFACES)[number],
) {
    const filename = resolve(PROJECT_ROOT, runner.path);
    const resources: string[] = [];
    const helperLoads: string[] = [];
    const stderr: string[] = [];
    const launches: {mode: 'background' | 'headed' | 'webkit'; options: Record<string, unknown>}[] = [];
    let finish!: (code: number) => void;
    const completed = new Promise<number>((done) => {finish = done;});
    const stopAtLaunch = (mode: (typeof launches)[number]['mode']) => (...args: unknown[]) => {
        launches.push({mode, options: args[args.length - 1] as Record<string, unknown>});
        throw new Error(LAUNCH_BOUNDARY_ERROR);
    };
    const helper: Record<string, unknown> = {
        launchFocusSafePersistentContext: stopAtLaunch('background'),
        newPageWithoutForeground: () => {throw new Error('Unexpected page creation before launch');},
        activateExtensionTabWithoutForeground: () => {throw new Error('Unexpected tab activation before launch');},
    };
    if (missingInterface) delete helper[missingInterface];
    const fsPort = {
        existsSync: (file: string) => file !== helperPath || helperExists,
        mkdirSync: () => {resources.push('artifacts-directory');},
        mkdtempSync: (prefix: string) => {resources.push('profile'); return `${prefix}cli-probe`;},
        rmSync: () => undefined,
        rmdirSync: () => undefined,
    };
    const httpPort = {
        createServer: () => {
            resources.push('fixture-server');
            return {
                listen: (_port: number, _host: string, ready: () => void) => {
                    resources.push('fixture-listen'); ready();
                },
                address: () => ({port: 49152}),
                close: (closed: () => void) => closed(),
                closeAllConnections: () => undefined,
            };
        },
    };
    const cliModule = {exports: {}};
    const cliRequire = Object.assign((specifier: string): unknown => {
        if (specifier === 'node:fs') return fsPort;
        if (specifier === 'node:http') return httpPort;
        if (specifier === 'node:path') return require('node:path');
        if (specifier === 'node:os') return {tmpdir: () => '/tmp', homedir: () => '/Users/cli-probe'};
        if (specifier === 'node:module') return {createRequire: () => cliRequire};
        if (specifier === './testing/owned-browser-close.cjs') return {
            guardBrowserClose: () => {throw new Error('Unexpected browser ownership before launch');},
        };
        if (specifier === 'playwright') return {
            chromium: {launchPersistentContext: stopAtLaunch('headed')},
            webkit: {launch: stopAtLaunch('webkit')},
        };
        if (specifier === helperPath) {helperLoads.push(specifier); return helper;}
        throw new Error(`Unexpected CLI dependency: ${specifier}`);
    }, {main: cliModule});
    const cliProcess = Object.defineProperty({
        argv: [process.execPath, filename, ...runner.requiredArgs, ...extraArgs],
        env,
        stderr: {write: (message: string) => {stderr.push(String(message));}},
    }, 'exitCode', {set: (code: number) => finish(code)});
    new Script(readScript(runner.path), {filename}).runInNewContext({
        require: cliRequire, module: cliModule, exports: cliModule.exports,
        __dirname: dirname(filename), __filename: filename, process: cliProcess,
        console: {
            error: (...messages: unknown[]) => {stderr.push(messages.map(String).join(' '));},
            log: () => {throw new Error('CLI unexpectedly completed without reaching the launch boundary');},
        },
    }, {timeout: 1000});
    return {exitCode: await completed, stderr: stderr.join('\n'), resources, helperLoads, launches};
}

function descendantNodes(root: ts.Node): ts.Node[] {
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node) => {nodes.push(node); ts.forEachChild(node, visit);};
    visit(root);
    return nodes;
}

function isBackgroundCondition(node: ts.Node, userscript: boolean): boolean {
    return userscript
        ? ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === 'args' && node.name.text === 'background'
        : ts.isIdentifier(node) && node.text === 'background';
}

function literalEvidence(node: ts.Expression): unknown {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
            throw new Error('Headed evidence must contain explicit literal properties');
        }
        return [property.name.text, literalEvidence(property.initializer)];
    }));
    throw new Error('Headed evidence is not an explicit literal');
}

function assertHeadedCliEvidence(path: string) {
    const userscript = path === 'scripts/run-userscript-smoke-test.cjs';
    const ast = ts.createSourceFile(path, readScript(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const owner = ast.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === (userscript ? 'main' : 'measurePage'));
    if (!owner?.body) throw new Error('Missing CLI launch owner');
    const backgroundBranch = descendantNodes(owner.body).find((node): node is ts.IfStatement =>
        ts.isIfStatement(node) && isBackgroundCondition(node.expression, userscript));
    if (!backgroundBranch?.elseStatement || !ts.isBlock(backgroundBranch.elseStatement)) {
        throw new Error('Missing explicit headed launch branch');
    }
    const headedNodes = descendantNodes(backgroundBranch.elseStatement);
    const headedCalls = headedNodes.filter(ts.isCallExpression);
    expect(headedCalls.filter((call) => ts.isPropertyAccessExpression(call.expression)
        && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'chromium'
        && call.expression.name.text === 'launchPersistentContext')).toHaveLength(1);
    expect(headedCalls.filter((call) => (ts.isIdentifier(call.expression)
        && call.expression.text === 'loadFocusSafeBrowser') || (ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === 'launchFocusSafePersistentContext'))).toHaveLength(0);
    const expected = {
        launchMode: 'playwright-headed',
        focusPolicy: 'foreground-authorized',
        windowPlacement: {mode: 'headed-explicit-foreground', windowState: 'normal', viewport: {width: 1280, height: 900}},
    };
    for (const [name, value] of Object.entries(expected)) {
        const assignments = headedNodes.filter((node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(node.left) && node.left.text === name);
        if (userscript) {
            expect(assignments).toHaveLength(0);
            const declaration = owner.body.statements.filter(ts.isVariableStatement)
                .flatMap((statement) => [...statement.declarationList.declarations])
                .find((node) => ts.isIdentifier(node.name) && node.name.text === name);
            if (!declaration?.initializer || !ts.isConditionalExpression(declaration.initializer)
                || !isBackgroundCondition(declaration.initializer.condition, true)) {
                throw new Error(`Missing headed initial evidence: ${name}`);
            }
            expect(literalEvidence(declaration.initializer.whenFalse)).toEqual(value);
        } else {
            expect(assignments).toHaveLength(1);
            expect(literalEvidence(assignments[0].right)).toEqual(value);
        }
    }
    const body = owner.body.statements.find(ts.isTryStatement)?.tryBlock;
    if (!body) throw new Error('Missing CLI evidence owner');
    const report = userscript
        ? body.statements.filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations])
            .find((node) => ts.isIdentifier(node.name) && node.name.text === 'evidence')?.initializer
        : body.statements.find(ts.isReturnStatement)?.expression;
    if (!report || !ts.isObjectLiteralExpression(report)) throw new Error('Missing CLI evidence object');
    for (const name of Object.keys(expected)) {
        expect(report.properties.filter((property) => ts.isShorthandPropertyAssignment(property)
            && property.name.text === name)).toHaveLength(1);
    }
}

describe('browser regression focus safety', () => {
    it.each([
        {samples:[],error:'Explicit public URL subset'},
        {samples:{url:'https://example.test'},error:'Explicit public URL subset'},
        {samples:['file:///etc/hosts'],error:'HTTP(S) URLs without credentials'},
        {samples:['https://user:password@example.test'],error:'HTTP(S) URLs without credentials'},
        {samples:[{url:'https://example.test',openSelector:''}],error:'explicit selector'},
        {samples:[{url:'https://example.test',openSelector:null}],error:'explicit selector'},
        {samples:[{url:'https://example.test',openSelector:'x'.repeat(1025)}],error:'explicit selector'},
    ])('公开调查 CLI 在加载浏览器依赖及创建 profile 前拒绝不合法样本 $error', ({samples,error}) => {
        const directory=mkdtempSync(resolve(tmpdir(),'fluentread-inspection-cli-'));
        try {
            const urls=resolve(directory,'urls.json'),artifacts=resolve(directory,'artifacts');
            writeFileSync(urls,JSON.stringify(samples));
            const result=spawnSync(process.execPath,[resolve(PROJECT_ROOT,'scripts/testing/inspect-manga-readers.cjs'),
                '--urls-file',urls,'--artifacts-dir',artifacts,'--playwright-root',resolve(directory,'missing-runtime'),
                '--focus-safe-helper',resolve(directory,'missing-helper.cjs')],{encoding:'utf8',timeout:5000});
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(error);
            expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
            expect(existsSync(artifacts)).toBe(false);
        } finally {rmSync(directory,{recursive:true,force:true});}
    });
    it('实页入口在等待正文前保存 HTTP 状态，未预期的访问限制不能记为入口通过', () => {
        const source = readScript('scripts/testing/run-manga-entry-ui-test.cjs');
        const liveSource = source.slice(source.indexOf("const liveReadersFile=arg('reader-sites',null)"));
        expect(liveSource).toContain('(report.liveReaders??=[]).push(result)');
        expect(liveSource.indexOf('(report.liveReaders??=[]).push(result)')).toBeLessThan(liveSource.indexOf('if(sample.readerReadySelector)'));
        expect(liveSource.indexOf("result.result='access-restricted'")).toBeLessThan(liveSource.indexOf('if(sample.readerReadySelector)'));
        expect(liveSource).toContain('throw new Error(`Public reader access failed: HTTP');
        expect(liveSource).toContain("result.result='body-not-ready'");
        expect(liveSource).toContain('result.readerReadiness=');
    });
    it('公开正文调查的焦点或原生激活故障中止整批，创建与关闭页签均保留阶段校验', () => {
        const source = readScript('scripts/testing/inspect-manga-readers.cjs');
        expect(source).toContain("focusGuard('before-page-create')");
        expect(source).toContain("focusGuard('before-page-close')");
        expect(source).toContain("focusGuard('after-page-close')");
        expect(source).toContain("focusGuard('before-page-activation')");
        expect(source).toContain("focusGuard('after-page-activation')");
        expect(source).toMatch(/if \(error instanceof FocusSafetyError\) \{\s*report\.pages\.push\(result\);\s*throw error;/u);
        expect(source).toContain('throw new FocusSafetyError(`public-page-activation: ${error.message}`)');
        expect(source).toContain('throw new FocusSafetyError(`public-tab-state: ${error.message}`)');
        expect(source.indexOf("assert.ok(!activationExtension")).toBeLessThan(source.indexOf('fs.mkdtempSync('));
        expect(source).not.toContain('.bringToFront(');
    });
    it('全文配置读取复用隔离页并只在该页已关闭时重新创建', async () => {
        const {getConfigurationPage} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const context = {};
        const firstPage = {isClosed: vi.fn(() => false), close: vi.fn()};
        const replacement = {isClosed: vi.fn(() => false), close: vi.fn()};
        const createPage = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(replacement);

        await expect(getConfigurationPage(context, createPage)).resolves.toBe(firstPage);
        await expect(getConfigurationPage(context, createPage)).resolves.toBe(firstPage);
        expect(createPage).toHaveBeenCalledOnce();
        expect(firstPage.close).not.toHaveBeenCalled();
        firstPage.isClosed.mockReturnValue(true);
        await expect(getConfigurationPage(context, createPage)).resolves.toBe(replacement);
        expect(createPage).toHaveBeenCalledTimes(2);
        const otherCreatePage = vi.fn(async () => ({isClosed: () => false}));
        await getConfigurationPage({}, otherCreatePage);
        expect(otherCreatePage).toHaveBeenCalledOnce();
    });

    it('悬浮取消证据拒绝取消期间的新请求、短暂译文和无法恢复的新手势', () => {
        const {assertCancelledHoverGesture} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {
            initialRequests: 0,
            stages: Array.from({length: 3}, () => ({requests: 0, wrapperCount: 0, htmlStable: true})),
            freshGesture: {wrapperCount: 1, neighborCount: 0},
            restored: {wrapperCount: 0, htmlStable: true},
            urlBefore: 'http://127.0.0.1/fixture',
            urlAfter: 'http://127.0.0.1/fixture',
        };
        expect(() => assertCancelledHoverGesture(evidence)).not.toThrow();
        for (const stage of [
            {requests: 1, wrapperCount: 0, htmlStable: true},
            {requests: 0, wrapperCount: 1, htmlStable: true},
            {requests: 0, wrapperCount: 0, htmlStable: false},
        ]) {
            expect(() => assertCancelledHoverGesture({...evidence, stages: [stage, ...evidence.stages.slice(1)]}))
                .toThrow('已取消的悬浮组合键重新触发翻译');
        }
        expect(() => assertCancelledHoverGesture({
            ...evidence, freshGesture: {wrapperCount: 0, neighborCount: 0},
        })).toThrow('新悬浮手势没有正常恢复');
        expect(() => assertCancelledHoverGesture({...evidence, urlAfter: 'http://127.0.0.1/unexpected'}))
            .toThrow('新悬浮手势没有正常恢复');
    });

    it('同值属性证据同时拒绝短暂原文、缓存掩盖的 DOM 重建和几何跳动', () => {
        const {assertUnchangedAttributeStability} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const target = {sameOwner: true, sameSlots: true, htmlStable: true, domMutations: 0,
            invalidPaintFrames: 0, maxGeometryDelta: 0};
        const evidence = {beforeRequests: 5, afterRequests: 5, paintFrames: 24, targets: [target, target]};
        expect(() => assertUnchangedAttributeStability(evidence)).not.toThrow();
        for (const failure of [
            {sameOwner: false}, {sameSlots: false}, {htmlStable: false}, {domMutations: 2},
            {invalidPaintFrames: 1}, {maxGeometryDelta: 1},
        ]) {
            expect(() => assertUnchangedAttributeStability({...evidence, targets: [{...target, ...failure}, target]}))
                .toThrow('同值属性写入重建了已完成的单译文或控件');
        }
        expect(() => assertUnchangedAttributeStability({...evidence, afterRequests: 6}))
            .toThrow('同值属性写入重建了已完成的单译文或控件');
        expect(() => assertUnchangedAttributeStability({...evidence, paintFrames: 0}))
            .toThrow('同值属性写入重建了已完成的单译文或控件');
    });

    it('仅译文保护区证据要求原 Text 保留且只有剩余来源仍有译文', () => {
        const {assertSingleSourceProtection} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {beforeSlots: 2, afterSlots: 1, protectedSlots: 0,
            protectedSourcePreserved: true, sameProtectedSource: true, remainingTranslated: true,
            loadingCount: 0, retryCount: 0};
        expect(() => assertSingleSourceProtection(evidence)).not.toThrow();
        for (const failure of [{afterSlots: 2}, {afterSlots: 0}, {protectedSlots: 1},
            {protectedSourcePreserved: false}, {sameProtectedSource: false}, {remainingTranslated: false}]) {
            expect(() => assertSingleSourceProtection({...evidence, ...failure}))
                .toThrow('仅译文的后代保护边界变化没有重建正确来源');
        }
    });

    it('仅译文克隆证据拒绝丢失原文、沿用无 ShadowRoot 的克隆槽与错误恢复节点', () => {
        const {assertSingleCloneRestoration} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {sameOwner: true, sourceTextPreserved: true, sameClonedSource: true,
            rebuiltSlot: true, translated: true, slotCount: 1, restoredTextPreserved: true,
            restoredClonedSource: true, restoredSlotCount: 0};
        expect(() => assertSingleCloneRestoration(evidence)).not.toThrow();
        for (const failure of [{sourceTextPreserved: false}, {sameClonedSource: false}, {rebuiltSlot: false},
            {slotCount: 2}, {restoredTextPreserved: false}, {restoredClonedSource: false}]) {
            expect(() => assertSingleCloneRestoration({...evidence, ...failure}))
                .toThrow('仅译文宿主克隆丢失原文或无法恢复');
        }
    });

    it('全文回归内建 fixture handler 只提供预期页面并禁用缓存', () => {
        const {
            assertDeterministicFixtureTraffic,
            assertNoRuntimeErrors,
            buildFixtureMicrosoftResponseBody,
            createFixtureRequestHandler,
            parseArgs,
        } = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs'));
        const handler = createFixtureRequestHandler(Buffer.from('fixture html'));
        const okResponse = {writeHead: vi.fn(), end: vi.fn()};
        const missingResponse = {writeHead: vi.fn(), end: vi.fn()};

        handler({url: '/unified-translation-fixture.html'}, okResponse);
        expect(okResponse.writeHead).toHaveBeenCalledWith(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
        });
        expect(okResponse.end).toHaveBeenCalledWith(Buffer.from('fixture html'));

        handler({url: '/unexpected'}, missingResponse);
        expect(missingResponse.writeHead).toHaveBeenCalledWith(404, {
            'content-type': 'text/plain; charset=utf-8',
        });
        expect(missingResponse.end).toHaveBeenCalledWith('Not found');

        expect(JSON.parse(buildFixtureMicrosoftResponseBody(['one', '<b>two</b>']))).toEqual([
            {translations: [{text: '测试译文：one'}]},
            {translations: [{text: '测试译文：<b>two</b>'}]},
        ]);
        expect(JSON.parse(buildFixtureMicrosoftResponseBody({text: 'invalid'}))).toEqual([]);
        expect(() => assertNoRuntimeErrors([])).not.toThrow();
        expect(() => assertNoRuntimeErrors(['pageerror: fixture failed'])).toThrow(
            '全文翻译浏览器回归出现运行时错误：["pageerror: fixture failed"]',
        );
        expect(() => assertDeterministicFixtureTraffic(12, [])).not.toThrow();
        expect(() => assertDeterministicFixtureTraffic(0, [])).toThrow('未命中确定性微软翻译路由');
        expect(() => assertDeterministicFixtureTraffic(12, ['https://translate.googleapis.com/translate_a/single']))
            .toThrow('尝试访问未授权网络');

        const requiredArgs = [
            '--extension-dir', '.output/chrome-mv3',
            '--playwright-root', '/tmp/playwright-runtime',
            '--focus-safe-helper', '/tmp/focus-safe-browser.cjs',
        ];
        expect(parseArgs(requiredArgs).service).toBe('freeTranslation');
        expect(parseArgs([...requiredArgs, '--verify-loading-style-isolation']).verifyLoadingStyleIsolation).toBe(true);
        expect(() => parseArgs([...requiredArgs, '--service', 'google'])).toThrow('只允许 freeTranslation');
        expect(() => parseArgs([...requiredArgs, '--configure-service', 'google'])).toThrow('只允许 freeTranslation');
        expect(() => parseArgs([...requiredArgs, '--url', 'https://example.com/fixture'])).toThrow(
            '只允许 loopback URL',
        );
        for (const script of [
            'scripts/run-selection-trigger-test.cjs',
            'scripts/run-full-page-translation-test.cjs',
            'scripts/run-video-subtitle-fixture-test.cjs',
        ]) {
            expect(readScript(script)).toContain("'report.json'");
        }
        const selectionSource = readScript('scripts/run-selection-trigger-test.cjs');
        expect(selectionSource).toContain('if (!result.ok) throw new Error');
        const selectionHash = selectionSource.match(/\/options\.html(#[a-z-]+)/u)?.[1];
        expect(selectionHash).toBe('#settings-selection');
        const selectionSection = resolveRequestedSection(selectionHash!);
        expect(resolveNavigationItem(selectionSection).label).toBe('划词翻译');
        const selectionMarkup = readScript('src/features/settings/ui/SettingsSections.vue')
            .match(new RegExp(`<section\\b[^>]*\\bid="${selectionSection}"[^>]*>([\\s\\S]*?)</section>`, 'u'))?.[1];
        expect(selectionMarkup).toBeDefined();
        expect(selectionMarkup).toMatch(/<SelectionSettings\b/u);
        expect(selectionSource).not.toContain('/options.html#settings-shortcuts');
        const fullPageSource = readScript('scripts/run-full-page-translation-test.cjs');
        expect(fullPageSource).toContain("matches(':hover') === true");
        expect(fullPageSource).toContain('悬浮翻译可信手势未落到预期失败态');
        expect(fullPageSource).toContain('HOST PAGE');
        expect(fullPageSource).toContain('动态注入 hostile CSS 后');
        expect(fullPageSource).toContain('开放 ShadowRoot 动态注入 hostile CSS 后');
        expect(fullPageSource).toContain("emulateMedia({reducedMotion: 'no-preference'})");
        expect(fullPageSource).toContain("emulateMedia({reducedMotion: 'reduce'})");
        expect(fullPageSource).not.toContain(':is(span.fluent-read-loading, span[data-fr-translation-owned="true"])');
        expect(fullPageSource).toContain('full-page-loading-style-isolation.png');
        const userscriptSource = readScript('scripts/run-userscript-smoke-test.cjs');
        expect(userscriptSource).toContain("emulateMedia({reducedMotion: 'no-preference'})");
        expect(userscriptSource).toContain('}, 1000);');
        const videoSource = readScript('scripts/run-video-subtitle-fixture-test.cjs');
        expect(videoSource).toContain("const navigationMode = 'offline-youtube-fixture'");
        expect(videoSource).not.toContain('live-youtube');
        expect(videoSource).toContain("await context.route('**/*'");
        expect(videoSource).toContain('unexpectedNetworkRequests.length === 0');
        expect(videoSource).toContain('if (!evidence.ok)');
        const privacySource = readScript('scripts/run-privacy-boundary-test.cjs');
        expect(privacySource).toContain('configurePrivacySurfaces(optionsPage');
        expect(privacySource).toContain("type: 'persistConfig'");
        expect(privacySource).toContain('baseRevision');
        expect(privacySource).toContain('exportCompleteBackupViaOptionsUi');
        expect(privacySource).toContain("name: '导出备份'");
        expect(privacySource).toContain("name: '不包含并导出'");
        expect(privacySource).toContain("waitForEvent('download'");
        expect(privacySource).toContain('includesPrivateVocabularyContext');
        expect(privacySource).toContain(
            "document.querySelectorAll('[data-service-configuration-service=\"openai\"] input[type=\"password\"]')",
        );
        expect(privacySource).not.toContain('input[placeholder="\u8bf7\u8f93\u5165API\u8bbf\u95ee\u4ee4\u724c"]');
        expect(privacySource).not.toContain("name: '导出配置'");
        expect(privacySource).not.toContain('config-transfer-dialog');
        expect(privacySource).not.toContain('configurePrivacySurfaces(worker');
        expect(privacySource).not.toContain('chrome.storage.local.set({ config: next })');
    });

    it('userscript 后台 smoke 不复用 helper 可能关闭的启动页', async () => {
        const {selectUserscriptTestPage} = require(resolve(
            PROJECT_ROOT,
            'scripts/run-userscript-smoke-test.cjs',
        ));
        const startupPage = {id: 'startup'};
        const isolatedPage = {id: 'isolated'};
        const context = {pages: vi.fn(() => [startupPage])};
        const createIsolatedPage = vi.fn(async () => isolatedPage);

        await expect(selectUserscriptTestPage(true, context, createIsolatedPage)).resolves.toBe(isolatedPage);
        expect(context.pages).not.toHaveBeenCalled();
        expect(createIsolatedPage).toHaveBeenCalledOnce();

        createIsolatedPage.mockClear();
        await expect(selectUserscriptTestPage(false, context, createIsolatedPage)).resolves.toBe(startupPage);
        expect(context.pages).toHaveBeenCalledOnce();
        expect(createIsolatedPage).not.toHaveBeenCalled();
    });

    it('设置中心浏览器回归锁定完整备份与恢复契约', () => {
        const source = readScript('scripts/testing/run-settings-center-ui-test.cjs');

        expect(source).toContain("['settings-data', '备份与恢复']");
        expect(source).toContain("name: '自动设置快照'");
        expect(source).toContain("name: '导出备份'");
        expect(source).toContain("name: '从备份恢复'");
        expect(source).toContain("getByText('是否包含单词上下文？'");
        expect(source).toContain("page.waitForEvent('download'");
        expect(source).toContain("page.waitForEvent('filechooser'");
        expect(source).toContain("getByTestId('restore-source-dialog')");
        expect(source).toContain("getByTestId('local-data-import-dialog')");
        expect(source).toContain("filter({hasText: /^凭据安全/u})");
        expect(source).toContain('const hiddenCredentialSentinels = [');
        expect(source).toContain('importPreviewText.includes(sentinels.proxy)');
        expect(source).toContain("value.format !== 'fluentread-data-backup'");
        expect(source).toContain("value.configCredentialMode !== 'exact-replace'");
        expect(source).toContain("['服务 / 模型', '输入', '缓存', '输出', '次数', '总计']");
        expect(source).toContain('index % 5 === 0');
        expect(source).toContain('index % 5 === 2');
        expect(source).toContain('流畅阅读 译文缓存或配置历史');
        expect(source).toContain("getByText('缓存读取未上报'");
        expect(source).toContain("getByText('暂时无法拆分输入与缓存构成'");
        expect(source).toContain("mode: 'patch'");
        expect(source).toContain('expected: {vocabularyBookEnabled: previousBetaEnabled}');
        expect(source).toContain('vocabularyBookEnabled: true');
        expect(source).not.toContain("['settings-data', '配置管理']");
        expect(source).not.toContain("name: '定时备份'");
        expect(source).not.toContain("getByRole('button', {name: '导出配置'");
        expect(source).not.toContain("getByRole('button', {name: '导入配置'");
        expect(source).not.toContain("getByTestId('config-transfer-dialog')");
    });

    it('按需设置页专项覆盖未访问分区、缓存返回、深链接与 Popup 基本交互', () => {
        const source = readScript('scripts/testing/run-lazy-options-ui-test.cjs');

        expect(source).toContain('first-general-mount-excludes-unvisited-sections');
        expect(source).toContain('interface-deep-link-mounts-target-section-first');
        expect(source).toContain('visited-sections-remain-mounted-after-return');
        expect(source).toContain('about-is-the-only-visible-content-branch');
        expect(source).toContain('boolean-setting-survives-immediate-options-close-and-reopen');
        expect(source).toContain('rapid-consecutive-setting-writes-retain-final-value');
        expect(source).toContain('options-setting-is-visible-in-reopened-popup');
        expect(source).toContain('popup-service-picker-opens-and-closes-with-escape');
        expect(source).toContain('popup-selection-drawer-opens-and-closes');
        expect(source).toContain('report.consoleErrors');
    });

    it('界面回归夹具跟随当前 Popup 快捷抽屉与服务目录结构', () => {
        const selectionSource = readScript('scripts/run-selection-trigger-test.cjs');
        expect(selectionSource).toContain('input[aria-label="划词翻译触发方式"]');
        expect(selectionSource).toContain("getByRole('group', { name: '划词翻译模式' })");
        expect(selectionSource).toContain("service: 'microsoft'");
        expect(selectionSource).not.toContain("getByText('触发方式'");
        expect(selectionSource).not.toContain('.chips.two button');

        const popupStartupSource = readScript('scripts/testing/run-popup-startup-ui-test.cjs');
        expect(popupStartupSource).toContain('Debugger.getScriptSource');
        expect(popupStartupSource).toContain("const editorMarker = 'custom-hotkey-dialog'");
        expect(popupStartupSource).not.toContain("getByRole('button', {name: '自定义', exact: true})");

        const settingsSource = readScript('scripts/testing/run-settings-center-ui-test.cjs');
        expect(settingsSource).toContain(
            "['基础配置', ['settings-general', 'settings-services', 'settings-translation', 'settings-interface']]",
        );
        expect(settingsSource).toContain("[data-service-value^=\"custom:\"]");
        for (const staleSelector of ['data-service-subgroup', '.custom-service-group', 'data-service-section-toggle', '.service-item']) {
            expect(settingsSource).not.toContain(staleSelector);
        }

        const librarySource = readScript('scripts/testing/run-service-library-ui-test.cjs');
        expect(librarySource).toContain("first-use-complete-directory");
        expect(librarySource).not.toContain("viewButton('custom')");

        const catalogSource = readScript('scripts/testing/run-service-catalog-ui-test.cjs');
        expect(catalogSource).toContain("'machine-services', 'cloud-services', 'ai-providers', 'ai-platforms'");
        expect(catalogSource).toContain('[data-free-translation-settings]');
        expect(catalogSource).not.toContain('[data-service-section="machine"]');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 的后台路径强制使用焦点安全 helper', (path) => {
        const source = readScript(path);

        expect(source).toContain('focus-safe-helper');
        expect(source).toContain('launchFocusSafePersistentContext');
        expect(source).toContain('newPageWithoutForeground');
    });

    it.each(ACTIVATED_EXTENSION_TAB_SCRIPTS)('%s 激活扩展页时不抢前台焦点', (path) => {
        const source = readScript(path);

        expect(source).toContain('activateExtensionTabWithoutForeground');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 不再使用最小化窗口或 bringToFront 伪装后台安全', (path) => {
        const source = readScript(path);

        expect(source).not.toContain('--start-minimized');
        expect(source).not.toContain('--window-position=-10000');
        expect(source).not.toContain('.bringToFront(');
        expect(source).not.toContain('playwright-minimized-fallback');
        expect(source).not.toContain('best-effort-minimized');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 输出可审计的启动与焦点策略', (path) => {
        const source = readScript(path);

        expect(source).toContain('launchMode');
        expect(source).toContain('focusPolicy');
        expect(source).toContain('windowPlacement');
    });

    it.each(RUNNER_CLI_CASES)('$path 默认后台模式缺少 helper 时失败即停', async (runner) => {
        const {path, requiredArgs} = runner;
        const {parseArgs} = require(resolve(PROJECT_ROOT, path));
        if (!BUNDLED_HELPER_CLI_PATHS.includes(path)) {
            expect(() => parseArgs(requiredArgs, {})).toThrow(/--focus-safe-helper|FLUENTREAD_FOCUS_SAFE_HELPER/);
            return;
        }
        const defaults = parseArgs(requiredArgs, {});
        expect(defaults.background).toBe(true);
        expect(defaults.focusSafeHelper).toBe(BUNDLED_FOCUS_SAFE_HELPER);
        const failures: (FocusSafeCliSelection & {missingInterface?: (typeof FOCUS_SAFE_INTERFACES)[number]})[] = [
            {extraArgs: [], env: {}, helperPath: BUNDLED_FOCUS_SAFE_HELPER, helperExists: false},
            {extraArgs: ['--focus-safe-helper', '/tmp/missing-explicit-helper.cjs'], env: {},
                helperPath: '/tmp/missing-explicit-helper.cjs', helperExists: false},
            {extraArgs: [], env: {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/missing-env-helper.cjs'},
                helperPath: '/tmp/missing-env-helper.cjs', helperExists: false},
            ...FOCUS_SAFE_INTERFACES.map((missingInterface) => ({extraArgs: [], env: {},
                helperPath: BUNDLED_FOCUS_SAFE_HELPER, helperExists: true, missingInterface})),
        ];
        for (const failure of failures) {
            const result = await probeFocusSafeCli(runner, failure.extraArgs, failure.env,
                failure.helperPath, failure.helperExists, failure.missingInterface);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(failure.missingInterface
                ? `后台浏览器辅助脚本缺少接口：${failure.missingInterface}`
                : `找不到后台浏览器辅助脚本：${failure.helperPath}`);
            expect(result.helperLoads).toEqual(failure.helperExists ? [failure.helperPath] : []);
            expect(result.launches).toEqual([]);
            expect(result.resources, `${path}: helper validation must precede fixture/profile/artifact creation`).toEqual([]);
        }
    });

    it.each(RUNNER_CLI_CASES)('$path 接受显式 helper 或环境变量，且 headed 不伪装后台', async (runner) => {
        const {path, requiredArgs} = runner;
        const {parseArgs} = require(resolve(PROJECT_ROOT, path));
        const explicit = parseArgs([...requiredArgs, '--focus-safe-helper', '/tmp/focus-safe-browser.cjs'], {});
        const fromEnv = parseArgs(requiredArgs, {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/focus-safe-browser.cjs'});
        const headed = parseArgs([...requiredArgs, '--headed'], {});

        expect(explicit.background).toBe(true);
        expect(explicit.focusSafeHelper).toBe('/tmp/focus-safe-browser.cjs');
        expect(fromEnv.background).toBe(true);
        expect(fromEnv.focusSafeHelper).toBe('/tmp/focus-safe-browser.cjs');
        expect(headed.background).toBe(false);
        if (!BUNDLED_HELPER_CLI_PATHS.includes(path)) {
            expect(headed.focusSafeHelper).toBe('');
            return;
        }
        // Retaining a helper path is harmless in headed mode; the executed launch
        // branch and the emitted evidence, rather than an empty path, are the contract.
        expect(headed.focusSafeHelper).toBe(BUNDLED_FOCUS_SAFE_HELPER);
        expect(parseArgs(requiredArgs, {FLUENTREAD_FOCUS_SAFE_HELPER: ''}).focusSafeHelper)
            .toBe(BUNDLED_FOCUS_SAFE_HELPER);
        expect(parseArgs([...requiredArgs, '--focus-safe-helper', '/tmp/explicit-helper.cjs'],
            {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/env-helper.cjs'}).focusSafeHelper).toBe('/tmp/explicit-helper.cjs');
        const branches: (FocusSafeCliSelection & {headed: boolean})[] = [
            {extraArgs: [], env: {}, helperPath: BUNDLED_FOCUS_SAFE_HELPER, helperExists: true, headed: false},
            {extraArgs: ['--focus-safe-helper', '/tmp/focus-safe-browser.cjs'], env: {},
                helperPath: '/tmp/focus-safe-browser.cjs', helperExists: true, headed: false},
            {extraArgs: [], env: {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/focus-safe-browser.cjs'},
                helperPath: '/tmp/focus-safe-browser.cjs', helperExists: true, headed: false},
            {extraArgs: ['--focus-safe-helper', '/tmp/explicit-helper.cjs'],
                env: {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/env-helper.cjs'},
                helperPath: '/tmp/explicit-helper.cjs', helperExists: true, headed: false},
            {extraArgs: ['--headed'], env: {}, helperPath: BUNDLED_FOCUS_SAFE_HELPER,
                helperExists: false, headed: true},
            {extraArgs: ['--headed', '--focus-safe-helper', '/tmp/missing-explicit-helper.cjs'],
                env: {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/missing-env-helper.cjs'},
                helperPath: '/tmp/missing-explicit-helper.cjs', helperExists: false, headed: true},
            {extraArgs: ['--headed'], env: {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/missing-env-helper.cjs'},
                helperPath: '/tmp/missing-env-helper.cjs', helperExists: false, headed: true},
        ];
        for (const branch of branches) {
            const result = await probeFocusSafeCli(runner, branch.extraArgs, branch.env, branch.helperPath, branch.helperExists);
            expect(result.exitCode).toBe(1); // The injected launch port deliberately throws before starting a browser.
            expect(result.stderr).toContain(LAUNCH_BOUNDARY_ERROR);
            expect(result.helperLoads).toEqual(branch.headed ? [] : [branch.helperPath]);
            expect(result.launches.map((launch) => launch.mode)).toEqual([branch.headed ? 'headed' : 'background']);
            expect(result.launches[0].options.headless).toBe(false);
            if (branch.headed) {
                expect(result.launches[0].options.executablePath).toBe(headed.browserPath);
                expect(result.launches[0].options).not.toHaveProperty('background');
            } else {
                expect(result.launches[0].options.background).toBe(true);
            }
        }
        assertHeadedCliEvidence(path);
    });

    it('userscript accepts an explicit compact-save scope and keeps selects as a separate unchanged scope', () => {
        const {parseArgs} = require(resolve(PROJECT_ROOT, 'scripts/run-userscript-smoke-test.cjs'));
        const args = RUNNER_CLI_CASES[0].requiredArgs;
        expect(parseArgs([...args, '--suite', 'compact-save'], {}).suite).toBe('compact-save');
        expect(parseArgs([...args, '--suite', 'selects'], {}).suite).toBe('selects');
        expect(parseArgs([...args, '--suite', 'compact-save'], {}).background).toBe(true);
        expect(() => parseArgs([...args, '--suite', 'compact-skip-layout'], {})).toThrow('无法识别测试套件');
    });

    it('WebKit userscript 回归只运行无窗口模式，且不需要前台浏览器 helper', async () => {
        const {parseArgs} = require(resolve(PROJECT_ROOT, 'scripts/run-userscript-smoke-test.cjs'));
        const args = [...RUNNER_CLI_CASES[0].requiredArgs, '--engine', 'webkit'];

        expect(parseArgs(args, {}).engine).toBe('webkit');
        expect(() => parseArgs([...args, '--headed'], {})).toThrow('WebKit 回归只允许无窗口的后台模式');
        const result = await probeFocusSafeCli(RUNNER_CLI_CASES[0], ['--engine', 'webkit'], {}, BUNDLED_FOCUS_SAFE_HELPER, false);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(LAUNCH_BOUNDARY_ERROR);
        expect(result.helperLoads).toEqual([]);
        expect(result.launches.map((launch) => launch.mode)).toEqual(['webkit']);
        expect(result.launches[0].options.headless).toBe(true);
    });

    it('站点矩阵把后台 helper、独立证据目录和网络授权传给每个子进程', () => {
        const source = readScript('scripts/run-site-translation-matrix.cjs');

        expect(source).toContain('--focus-safe-helper');
        expect(source).toContain('--artifacts-dir');
        expect(source).toContain('--allow-network');
        expect(source).toContain('--background');
        expect(source).not.toContain('--start-minimized');
        expect(source).not.toContain('.bringToFront(');
    });
});

type SelectionContractConfig = {
    selectionTranslatorMode: 'disabled' | 'bilingual' | 'translation-only';
    selectionTranslatorModeBeforeDisable: 'bilingual' | 'translation-only';
    disableSelectionTranslator: boolean;
    selectionTranslatorTrigger: string;
    selectionTranslatorHotkey: string;
    customSelectionTranslatorHotkey: string;
};
type SelectionContractPopup = {
    checked: string | null | undefined;
    modes: {label: string; pressed: string | null; disabled: boolean}[];
};
type SelectionContractLocator = {
    getByRole(role: string, options?: {name?: string; exact?: boolean}): SelectionContractLocator;
    locator(selector: string): SelectionContractLocator;
    first(): SelectionContractLocator;
    getAttribute(name: string): Promise<string | null>;
    textContent(): Promise<string | null>;
    click(): Promise<void>;
    evaluate<T>(fn: (element: Element) => T): Promise<T>;
};
type SelectionContractUi = {
    popup: {waitForTimeout(ms: number): Promise<void>};
    options: SelectionContractLocator & {waitForTimeout(ms: number): Promise<void>};
    drawer: SelectionContractLocator;
    storagePage: object;
};
type SelectionContractHelpers = {
    readPopupSelectionState(drawer: SelectionContractLocator): Promise<SelectionContractPopup>;
    setSelectionEnabled(ui: SelectionContractUi, enabled: boolean): Promise<{
        popup: SelectionContractPopup; mode: string; disabled: boolean;
    }>;
    waitForSelectionTriggerState(ui: SelectionContractUi, label: string, timeout?: number): Promise<{
        label: string; options: string; popup: SelectionContractPopup;
        trigger: string; hotkey: string; customHotkey: string;
    }>;
};

// Read the complete current CJS, then transport its unchanged top-level declarations.
// The CLI entrypoint, browser loader and native/network ports are never evaluated.
function selectionContractDeclarations(names = [
    'SELECTION_MODE_VALUES', 'setSelectionEnabled', 'expectedSelectionTrigger',
    'selectionTriggerSelect', 'readPopupSelectionState', 'waitForSelectionTriggerState',
]): string {
    const path = 'scripts/run-selection-trigger-test.cjs';
    const ast = ts.createSourceFile(path, readScript(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return names.map((name) => {
        const declarations = ast.statements.filter((node) =>
            (ts.isFunctionDeclaration(node) && node.name?.text === name)
            || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
                ts.isIdentifier(declaration.name) && declaration.name.text === name)));
        if (declarations.length !== 1) throw new Error(`Expected one actual CJS declaration: ${name}`);
        return declarations[0].getText(ast);
    }).join('\n');
}

function createSelectionContractHarness(overrides: Partial<SelectionContractConfig> = {}) {
    const {parseHTML} = require('linkedom') as typeof import('linkedom');
    const {document, window} = parseHTML(`<html><body>
        <section id="drawer">
            <button type="button" role="switch" aria-label="划词翻译" data-testid="selection-enable" aria-checked="true"></button>
            <div role="group" aria-label="划词翻译模式">
                <button type="button" aria-pressed="false"> 双语显示 </button>
                <button type="button" aria-pressed="true"> 仅译文 </button>
            </div>
        </section>
        <section id="options"><div class="el-select__wrapper">
            <span class="el-select__placeholder"> 自定义 </span>
            <input aria-label="划词翻译触发方式">
        </div></section>
        <button type="button" aria-pressed="true" disabled>组外按钮</button>
    </body></html>`);
    const drawerElement = document.querySelector('#drawer') as unknown as HTMLElement;
    const optionsElement = document.querySelector('#options') as unknown as HTMLElement;
    const toggle = drawerElement.querySelector('[data-testid="selection-enable"]') as HTMLButtonElement;
    const modeButtons = [...drawerElement.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    const config: SelectionContractConfig = {
        selectionTranslatorMode: 'translation-only', selectionTranslatorModeBeforeDisable: 'translation-only',
        disableSelectionTranslator: false, selectionTranslatorTrigger: 'custom',
        selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: 'F9', ...overrides,
    };
    const clock = {now: 0};
    const trace: string[] = [];
    const switchClick = vi.fn((): void => undefined);
    const modeClick = vi.fn((): void => undefined);
    toggle.addEventListener('click', () => {trace.push('switch-click'); switchClick();});
    modeButtons.forEach((button) => button.addEventListener('click', modeClick));
    let afterWait: () => void = () => undefined;
    const waitForTimeout = vi.fn(async (ms: number) => {
        if (ms !== 100) throw new Error(`Unexpected selection polling interval: ${ms}`);
        clock.now += ms;
        afterWait();
    });
    function domLocator(elements: Element[]): SelectionContractLocator {
        const single = () => {
            if (elements.length !== 1) throw new Error(`DOM locator resolved ${elements.length} elements`);
            return elements[0];
        };
        return {
            getByRole: (role, options = {}) => domLocator(elements.flatMap((element) =>
                [...element.querySelectorAll(role === 'button' ? 'button, [role="button"]' : `[role="${role}"]`)]
                    .filter((candidate) => {
                        const name = candidate.getAttribute('aria-label') || candidate.textContent?.trim() || '';
                        return options.name === undefined || (options.exact ? name === options.name : name.includes(options.name));
                    }))),
            locator: (selector) => {
                // This one Playwright XPath dialect walks actual DOM ancestry;
                // it does not return the wrapper by identity regardless of the input.
                const candidates = selector.startsWith('xpath=ancestor::div[')
                    ? elements.map((element) => element.parentElement?.closest('div.el-select__wrapper')).filter((element): element is Element => !!element)
                    : elements.flatMap((element) => [...element.querySelectorAll(selector)]);
                return domLocator([...new Set(candidates)]);
            },
            first: () => domLocator(elements.slice(0, 1)),
            getAttribute: async (name) => single().getAttribute(name),
            textContent: async () => single().textContent,
            click: async () => {
                const element = single();
                if ((element as HTMLButtonElement).disabled) throw new Error('Cannot click a disabled DOM button');
                element.dispatchEvent(new window.Event('click'));
            },
            evaluate: async (fn) => fn(single()),
        };
    }
    const ui: SelectionContractUi = {
        popup: {waitForTimeout}, options: Object.assign(domLocator([optionsElement]), {waitForTimeout}),
        drawer: domLocator([drawerElement]), storagePage: {},
    };
    const activateInputPage = vi.fn(async (page: unknown) => {
        if (page !== ui.popup) throw new Error('Selection switch must activate its actual Popup port');
        trace.push('activate-popup');
    });
    const readStoredConfig = vi.fn(async (page: unknown) => {
        if (page !== ui.storagePage) throw new Error('Unexpected configuration page');
        return {...config};
    });
    const helpers = new Script(`${selectionContractDeclarations()}
        ({readPopupSelectionState, setSelectionEnabled, waitForSelectionTriggerState});`,
    {filename: 'selection-contract-actual-declarations.cjs'}).runInNewContext({
        Date: {now: () => clock.now}, activateInputPage, readStoredConfig,
    }, {timeout: 1000}) as SelectionContractHelpers;
    return {
        ui, helpers, config, clock, trace, toggle, modeButtons, drawerElement, optionsElement,
        switchClick, modeClick, activateInputPage, readStoredConfig, waitForTimeout,
        setAfterWait: (callback: () => void) => {afterWait = callback;},
    };
}

describe('selection CLI actual Popup contracts', () => {
    it('DOM 读取仅提取真实开关和模式组，保留按下与禁用状态且不依赖已移除预览', async () => {
        const h = createSelectionContractHarness();
        expect(h.drawerElement.querySelector('.interaction-preview')).toBeNull();
        await expect(h.helpers.readPopupSelectionState(h.ui.drawer)).resolves.toEqual({
            checked: 'true', modes: [
                {label: '双语显示', pressed: 'false', disabled: false},
                {label: '仅译文', pressed: 'true', disabled: false},
            ],
        });
        h.toggle.setAttribute('aria-checked', 'false');
        h.modeButtons.forEach((button) => {button.disabled = true;});
        await expect(h.helpers.readPopupSelectionState(h.ui.drawer)).resolves.toEqual({
            checked: 'false', modes: [
                {label: '双语显示', pressed: 'false', disabled: true},
                {label: '仅译文', pressed: 'true', disabled: true},
            ],
        });
        h.toggle.remove();
        expect((await h.helpers.readPopupSelectionState(h.ui.drawer)).checked).toBeUndefined();
        expect(h.readStoredConfig).not.toHaveBeenCalled();
    });

    it('通过真实 switch 恢复记住的仅译文，启用和停用均幂等且等待独立存储与 DOM 快照', async () => {
        const h = createSelectionContractHarness({selectionTranslatorMode: 'disabled', disableSelectionTranslator: true});
        h.toggle.setAttribute('aria-checked', 'false');
        h.modeButtons.forEach((button) => {button.disabled = true;});
        // Event responses are predeclared observations, not an implementation of
        // the helper's switch/mode algorithm or a result returned by the helper.
        const observations: {mode: SelectionContractConfig['selectionTranslatorMode']; disabled: boolean; checked: string}[] = [
            {mode: 'translation-only', disabled: false, checked: 'true'},
            {mode: 'disabled', disabled: true, checked: 'false'},
            {mode: 'translation-only', disabled: false, checked: 'true'},
        ];
        let pending: (typeof observations)[number] | undefined;
        h.switchClick.mockImplementation(() => {pending = observations.shift();});
        h.setAfterWait(() => {
            if (!pending) return;
            h.config.selectionTranslatorMode = pending.mode;
            h.config.disableSelectionTranslator = pending.disabled;
            h.toggle.setAttribute('aria-checked', pending.checked);
            h.modeButtons.forEach((button) => {button.disabled = pending!.disabled;});
            pending = undefined;
        });
        expect((await h.helpers.setSelectionEnabled(h.ui, true)).mode).toBe('translation-only');
        expect(h.clock.now).toBe(100);
        await h.helpers.setSelectionEnabled(h.ui, true);
        expect(h.switchClick).toHaveBeenCalledOnce();
        expect(h.clock.now).toBe(100);
        expect((await h.helpers.setSelectionEnabled(h.ui, false)).mode).toBe('disabled');
        await h.helpers.setSelectionEnabled(h.ui, false);
        expect(h.switchClick).toHaveBeenCalledTimes(2);
        expect(h.clock.now).toBe(200);
        const restored = await h.helpers.setSelectionEnabled(h.ui, true);
        expect(restored.mode).toBe('translation-only');
        expect(restored.popup.modes).toEqual([
            {label: '双语显示', pressed: 'false', disabled: false},
            {label: '仅译文', pressed: 'true', disabled: false},
        ]);
        expect(h.config.selectionTranslatorModeBeforeDisable).toBe('translation-only');
        expect(h.switchClick).toHaveBeenCalledTimes(3);
        expect(h.modeClick).not.toHaveBeenCalled();
        expect(h.activateInputPage).toHaveBeenCalledTimes(5);
        expect(h.trace).toEqual([
            'activate-popup', 'switch-click', 'activate-popup',
            'activate-popup', 'switch-click', 'activate-popup', 'activate-popup', 'switch-click',
        ]);
        expect(h.waitForTimeout.mock.calls).toEqual([[100], [100], [100]]);
        expect(observations).toHaveLength(0);
    });

    it('模式组缺失时启用与触发等待均拒绝空数组的 vacuous success', async () => {
        const h = createSelectionContractHarness();
        h.drawerElement.querySelector('[role="group"]')!.remove();
        await expect(h.helpers.readPopupSelectionState(h.ui.drawer)).resolves.toEqual({checked: 'true', modes: []});
        await expect(h.helpers.setSelectionEnabled(h.ui, true)).rejects.toThrow('划词翻译启用状态错误');
        expect(h.clock.now).toBe(10000);
        expect(h.readStoredConfig).toHaveBeenCalledTimes(100);
        await expect(h.helpers.waitForSelectionTriggerState(h.ui, '自定义', 300)).rejects.toThrow('Popup 模式或配置未稳定');
        expect(h.clock.now).toBe(10300);
        expect(h.readStoredConfig).toHaveBeenCalledTimes(103);
        expect(h.switchClick).not.toHaveBeenCalled();
    });

    it('持续存储或模式 DOM 不一致必须到 10000ms 截止失败，不重复点击已启用开关', async () => {
        for (const mismatch of ['stored-mode', 'stored-disable-flag', 'dom-disabled-mode'] as const) {
            const h = createSelectionContractHarness();
            if (mismatch === 'stored-mode') h.config.selectionTranslatorMode = 'disabled';
            if (mismatch === 'stored-disable-flag') h.config.disableSelectionTranslator = true;
            if (mismatch === 'dom-disabled-mode') h.modeButtons[1].disabled = true;
            await expect(h.helpers.setSelectionEnabled(h.ui, true)).rejects.toThrow('划词翻译启用状态错误');
            expect(h.clock.now, mismatch).toBe(10000);
            expect(h.readStoredConfig, mismatch).toHaveBeenCalledTimes(100);
            expect(h.waitForTimeout, mismatch).toHaveBeenCalledTimes(100);
            expect(h.waitForTimeout.mock.calls.every(([ms]) => ms === 100), mismatch).toBe(true);
            expect(h.switchClick, mismatch).not.toHaveBeenCalled();
        }
    });

    it('真实设置项与存储触发器匹配时接受启用双语、启用仅译文和停用后记住的仅译文', async () => {
        const observations: {label: string; config: Partial<SelectionContractConfig>; checked: string; bilingualPressed: string; disabled: boolean}[] = [
            {label: 'Ctrl', config: {selectionTranslatorMode: 'bilingual', selectionTranslatorTrigger: 'Control', selectionTranslatorHotkey: 'Control'}, checked: 'true', bilingualPressed: 'true', disabled: false},
            {label: '显示图标', config: {selectionTranslatorTrigger: 'icon', selectionTranslatorHotkey: 'none'}, checked: 'true', bilingualPressed: 'false', disabled: false},
            {label: '自定义', config: {selectionTranslatorMode: 'disabled', disableSelectionTranslator: true}, checked: 'false', bilingualPressed: 'false', disabled: true},
        ];
        for (const observation of observations) {
            const h = createSelectionContractHarness(observation.config);
            h.optionsElement.querySelector('.el-select__placeholder')!.textContent = ` ${observation.label} `;
            h.toggle.setAttribute('aria-checked', observation.checked);
            h.modeButtons[0].setAttribute('aria-pressed', observation.bilingualPressed);
            h.modeButtons[1].setAttribute('aria-pressed', observation.bilingualPressed === 'true' ? 'false' : 'true');
            h.modeButtons.forEach((button) => {button.disabled = observation.disabled;});
            const state = await h.helpers.waitForSelectionTriggerState(h.ui, observation.label, 300);
            expect(state.label).toBe(observation.label);
            expect(state.options).toBe(observation.label);
            expect(state.trigger).toBe(h.config.selectionTranslatorTrigger);
            expect(state.hotkey).toBe(h.config.selectionTranslatorHotkey);
            expect(state.popup.checked).toBe(observation.checked);
            expect(state.popup.modes.map((mode) => mode.disabled)).toEqual([observation.disabled, observation.disabled]);
            expect(state.customHotkey).toBe('F9');
            expect(h.readStoredConfig).toHaveBeenCalledOnce();
            expect(h.waitForTimeout).not.toHaveBeenCalled();
            expect(h.drawerElement.querySelector('.interaction-preview')).toBeNull();
        }
    });

    it('触发等待分别拒绝设置文本、trigger、hotkey、F9 或 Popup 任一状态持续不匹配', async () => {
        const changes: [string, (h: ReturnType<typeof createSelectionContractHarness>) => void][] = [
            ['options-label', (h) => {h.optionsElement.querySelector('.el-select__placeholder')!.textContent = 'Ctrl';}],
            ['trigger', (h) => {h.config.selectionTranslatorTrigger = 'icon';}],
            ['hotkey', (h) => {h.config.selectionTranslatorHotkey = 'none';}],
            ['custom-F9', (h) => {h.config.customSelectionTranslatorHotkey = 'F8';}],
            ['popup-switch', (h) => {h.toggle.setAttribute('aria-checked', 'false');}],
            ['popup-pressed', (h) => {h.modeButtons[0].setAttribute('aria-pressed', 'true'); h.modeButtons[1].setAttribute('aria-pressed', 'false');}],
            ['popup-disabled', (h) => {h.modeButtons[0].disabled = true;}],
        ];
        for (const [name, change] of changes) {
            const h = createSelectionContractHarness();
            change(h);
            await expect(h.helpers.waitForSelectionTriggerState(h.ui, '自定义', 300)).rejects.toThrow('Popup 模式或配置未稳定');
            expect(h.clock.now, name).toBe(300);
            expect(h.readStoredConfig, name).toHaveBeenCalledTimes(3);
            expect(h.waitForTimeout.mock.calls, name).toEqual([[100], [100], [100]]);
            expect(h.switchClick, name).not.toHaveBeenCalled();
        }
    });

    it('CDP 根读取保留纯空白参数和精确原文，复用返回的 session 且不提前 detach', async () => {
        const originalText = 'This neighboring paragraph must remain untouched.';
        // The independent CDP response contains whitespace Text nodes between
        // word spans. Its contents never depend on the requested CDP parameters.
        const root = {
            nodeName: 'DIV', children: [
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'This'}]},
                {nodeName: '#text', nodeValue: ' '},
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'neighboring'}]},
                {nodeName: '#text', nodeValue: ' '},
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'paragraph'}]},
                {nodeName: '#text', nodeValue: ' '},
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'must'}]},
                {nodeName: '#text', nodeValue: ' '},
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'remain'}]},
                {nodeName: '#text', nodeValue: ' '},
                {nodeName: 'SPAN', children: [{nodeName: '#text', nodeValue: 'untouched.'}]},
            ],
        };
        const session = {
            send: vi.fn(async (method: string, _parameters: unknown) => {
                if (method === 'DOM.enable') return {};
                if (method === 'DOM.getDocument') return {root};
                throw new Error(`Unexpected CDP command: ${method}`);
            }),
            detach: vi.fn(async () => undefined),
        };
        const context = {newCDPSession: vi.fn(async (_target: unknown) => session)};
        const page = {context: () => context};
        const declarations = selectionContractDeclarations([
            'selectionUiSessions', 'getSelectionUiTree', 'cdpChildren', 'cdpText',
        ]);
        const helpers = new Script(`${declarations}\n({getSelectionUiTree, cdpText});`,
            {filename: 'selection-cdp-actual-declarations.cjs'}).runInNewContext({}, {timeout: 1000}) as {
                getSelectionUiTree(target: typeof page): Promise<{session: typeof session; root: typeof root}>;
                cdpText(node: typeof root): string;
            };
        const first = await helpers.getSelectionUiTree(page);
        expect(first.session).toBe(session);
        expect(first.root).toBe(root);
        expect(helpers.cdpText(first.root)).toBe(originalText);
        await helpers.getSelectionUiTree(page);
        expect(context.newCDPSession).toHaveBeenCalledOnce();
        expect(context.newCDPSession).toHaveBeenCalledWith(page);
        expect(session.send.mock.calls).toEqual([
            ['DOM.enable', {includeWhitespace: 'all'}],
            ['DOM.getDocument', {depth: -1, pierce: true}],
            ['DOM.getDocument', {depth: -1, pierce: true}],
        ]);
        expect(session.detach).not.toHaveBeenCalled();
        const enableFailure = new Error('controlled DOM.enable failure');
        const rejectedSession = {
            send: vi.fn(async (_method: string, _parameters: unknown) => {throw enableFailure;}),
            detach: vi.fn(async () => undefined),
        };
        const retryContext = {newCDPSession: vi.fn()
            .mockResolvedValueOnce(rejectedSession).mockResolvedValueOnce(session)};
        const retryPage = {context: () => retryContext};
        await expect(helpers.getSelectionUiTree(retryPage)).rejects.toBe(enableFailure);
        expect(rejectedSession.send.mock.calls).toEqual([['DOM.enable', {includeWhitespace: 'all'}]]);
        expect(rejectedSession.detach).not.toHaveBeenCalled();
        const recovered = await helpers.getSelectionUiTree(retryPage);
        expect(helpers.cdpText(recovered.root)).toBe(originalText);
        expect(retryContext.newCDPSession).toHaveBeenCalledTimes(2);
        expect(retryContext.newCDPSession).toHaveBeenNthCalledWith(1, retryPage);
        expect(retryContext.newCDPSession).toHaveBeenNthCalledWith(2, retryPage);
        expect(session.send.mock.calls.slice(3)).toEqual([
            ['DOM.enable', {includeWhitespace: 'all'}],
            ['DOM.getDocument', {depth: -1, pierce: true}],
        ]);
        // The actual helper caches this session for later DOM/Input consumers;
        // its owning browser context, not a per-read finally, ends its lifetime.
        expect(session.detach).not.toHaveBeenCalled();
    });
});

/**
 * 直接调用公开 CLI 的真实 CDP reader 与 predicates，仅控制 CDP/page 传输值。
 * closed Shadow Tree、属性、样式、几何分开提供；不重写 reader、不启动浏览器。
 * 原有产品源码/CSS 断言完整保留；这些夹具不证明 Vue 实际渲染或 native PASS。
 */
type FloatingCdpNode = {
  nodeId: number;
  nodeName: string;
  attributes: string[];
  children?: FloatingCdpNode[];
  shadowRoots?: (FloatingCdpNode & {shadowRootType: 'closed'})[];
};
type FloatingCdpStyle = {opacity: string; visibility: string; display: string; transform?: string};
type FloatingCliState = {
  host: boolean; ball: boolean; expanded: boolean; translated: boolean;
  translateTool: boolean; translateToolPressed: string; mainCheck: boolean;
  check: boolean; checkVisible: boolean; progressHost: boolean; progressPanel: boolean;
  mainOpacity: number; translateToolOpacity: number;
  checkBox: {left: number; top: number; right: number; bottom: number} | null;
  progress: {running: number; remaining: number; queued: number; offscreen: number} | null;
};
type FloatingTreeOptions = {
  expanded?: boolean; pressed?: string | null; toolCheck?: boolean; mainCheck?: boolean;
  translateTool?: boolean; floatingHost?: boolean; legacyRootClass?: boolean;
  toolsDisplay?: 'hover' | 'always'; progressPanel?: boolean;
  toolStyle?: Partial<FloatingCdpStyle>; checkStyle?: Partial<FloatingCdpStyle>;
  checkQuad?: number[] | null;
  nodeIdOffset?: number;
};
const floatingCli = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs')) as {
  readFloatingUiState(page: unknown): Promise<FloatingCliState>;
  readFloatingUiState(page: unknown, allowPending: true): Promise<FloatingCliState | null>;
  isCollapsedFloatingUiState(state: FloatingCliState, translated: boolean): boolean;
  isExpandedFloatingUiState(state: FloatingCliState): boolean;
};

function makeFloatingCdpFixture(initial: FloatingTreeOptions = {}) {
  const node = (nodeId: number, nodeName: string, attributes: Record<string, string> = {},
    children: FloatingCdpNode[] = []): FloatingCdpNode => ({
    nodeId, nodeName, attributes: Object.entries(attributes).flat(), children,
  });
  const sessions: {send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>}[] = [];
  let root: FloatingCdpNode;
  let styles: Map<number, FloatingCdpStyle>;
  let quads: Map<number, number[]>;
  let documentError: Error | undefined;
  const styleReads = new Map<number, () => Promise<FloatingCdpStyle>>();

  function replace(options: FloatingTreeOptions) {
    const expanded = options.expanded === true;
    const pressed = options.pressed === undefined ? 'true' : options.pressed;
    const toolCheck = node(10, 'SPAN', {class: 'check-mark', 'aria-hidden': 'true'});
    const translate = node(6, 'BUTTON', {
      class: 'floating-ball-tool floating-ball-translate floating-ball-item',
      ...(pressed === null ? {} : {'aria-pressed': pressed}),
    }, options.toolCheck === false ? [] : [node(16, 'SVG', {class: 'translation-icon'}), toolCheck]);
    const brand = node(7, 'DIV', {class: 'floating-ball-main floating-ball-item', role: 'img'}, [
      node(8, 'SVG', {class: 'floating-ball-mascot'}, [node(18, 'IMAGE', {href: 'chrome-extension://fixture/icon/128.png'})]),
      ...(options.mainCheck ? [node(11, 'SPAN', {class: 'check-mark'})] : []),
    ]);
    const ball = node(5, 'DIV', {
      class: ['fr-floating-ball', ...(expanded ? ['floating-ball-expanded'] : []),
        ...(options.legacyRootClass ? ['is-translating'] : [])].join(' '),
      'data-position': 'left', 'data-tools-display': options.toolsDisplay || 'hover',
    }, [...(options.translateTool === false ? [] : [translate]), brand,
      node(9, 'BUTTON', {class: 'floating-ball-tool floating-ball-settings'})]);
    const floatingHost = node(2, 'FLUENT-READ-FLOATING-BALL-UI', {id: 'fluent-read-floating-ball-container'});
    floatingHost.shadowRoots = [{...node(3, '#document-fragment', {}, [node(4, 'DIV', {}, [ball])]), shadowRootType: 'closed'}];
    const progressHost = node(12, 'FLUENT-READ-TRANSLATION-PROGRESS-UI', {id: 'fluent-read-translation-status-container'});
    progressHost.shadowRoots = [{...node(13, '#document-fragment', {}, options.progressPanel ? [node(14, 'ASIDE', {
      class: 'fr-translation-progress', 'data-running': '2', 'data-remaining': '9',
      'data-queued': '3', 'data-offscreen': '6',
    })] : []), shadowRootType: 'closed'}];
    // 页面其他位置的同名 check 不能冒充悬浮球的状态。
    root = node(1, '#document', {}, [node(20, 'DIV', {class: 'check-mark'}),
      ...(options.floatingHost === false ? [] : [floatingHost]), progressHost]);
    styles = new Map<number, FloatingCdpStyle>([
      [7, {opacity: expanded ? '1' : '0.52', visibility: 'visible', display: 'flex', transform: 'matrix(1, 0, 0, 1, -40, 0)'}],
      [6, {opacity: expanded ? '1' : '0', visibility: 'visible', display: 'flex', ...options.toolStyle}],
      [10, {opacity: '1', visibility: 'visible', display: 'block', ...options.checkStyle}],
      [11, {opacity: '1', visibility: 'visible', display: 'block'}],
    ]);
    quads = new Map<number, number[]>([
      [7, [-20, 388, 20, 388, 20, 428, -20, 428]],
      [6, [16, 340, 56, 340, 56, 380, 16, 380]],
      [11, [-2, 388, 12, 388, 12, 402, -2, 402]],
    ]);
    if (options.checkQuad !== null) {
      quads.set(10, options.checkQuad ?? [42, 338, 56, 338, 56, 352, 42, 352]);
    }
    if (options.nodeIdOffset) {
      const offset = options.nodeIdOffset;
      const rebase = (current: FloatingCdpNode) => {
        current.nodeId += offset;
        for (const child of [...(current.children || []), ...(current.shadowRoots || [])]) rebase(child);
      };
      rebase(root);
      styles = new Map([...styles].map(([id, style]) => [id + offset, style]));
      quads = new Map([...quads].map(([id, quad]) => [id + offset, quad]));
    }
  }
  replace(initial);
  const page = {
    context: () => ({newCDPSession: vi.fn(async () => {
      const session = {
        send: vi.fn(async (command: string, params?: {nodeId?: number; depth?: number; pierce?: boolean}) => {
          if (command === 'DOM.enable' || command === 'CSS.enable') return {};
          if (command === 'DOM.getDocument') {
            expect(params).toEqual({depth: -1, pierce: true});
            if (documentError) throw documentError;
            return {root};
          }
          if (command === 'CSS.getComputedStyleForNode') {
            const read = styleReads.get(params!.nodeId!);
            const style = read ? await read() : styles.get(params!.nodeId!);
            if (!style) throw new Error(`Unexpected computed-style node ${params?.nodeId}`);
            return {computedStyle: Object.entries(style).map(([name, value]) => ({name, value}))};
          }
          if (command === 'DOM.getBoxModel') {
            const quad = quads.get(params!.nodeId!);
            if (!quad) throw new Error('Controlled missing box model');
            return {model: {border: quad}};
          }
          throw new Error(`Unexpected CDP command ${command}`);
        }),
        detach: vi.fn(async () => undefined),
      };
      sessions.push(session);
      return session;
    })}),
    waitForTimeout: vi.fn(async (_milliseconds: number) => undefined),
    // 执行 CLI 传入的原 viewport callback，而不是以预制结果替换 callback。
    evaluate: vi.fn(async (callback: () => unknown) => new Script(`(${callback.toString()})()`).runInNewContext({
      window: {innerWidth: 1280, innerHeight: 900},
    }, {timeout: 1000})),
  };
  return {page, sessions, replace, failDocument: (error: Error) => {documentError = error;},
    controlStyle: (nodeId: number, read: () => Promise<FloatingCdpStyle>) => {styleReads.set(nodeId, read);},
    clearStyleReads: () => styleReads.clear()};
}

describe('全文公开 CLI 的真实 CDP reader 与悬浮状态契约', () => {
  it('穿过 closed Shadow Tree 读取按钮 active，收起时 check DOM 在但不可见', async () => {
    const fixture = makeFloatingCdpFixture();
    const state = await floatingCli.readFloatingUiState(fixture.page);
    expect(state).toMatchObject({host: true, ball: true, expanded: false, translated: true,
      translateTool: true, translateToolPressed: 'true', mainCheck: false, check: true, checkVisible: false,
      mainOpacity: 0.52, translateToolOpacity: 0, progressHost: true, progressPanel: false});
    expect(state.checkBox).toEqual({left: 42, top: 338, right: 56, bottom: 352});
    expect(floatingCli.isCollapsedFloatingUiState(state, true)).toBe(true);
    expect(floatingCli.isCollapsedFloatingUiState(state, false)).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
    expect(fixture.sessions[0].send).toHaveBeenCalledWith('DOM.getBoxModel', {nodeId: 10});
    expect(fixture.sessions[0].send).not.toHaveBeenCalledWith('DOM.getBoxModel', {nodeId: 20});
    expect(fixture.sessions[0].detach).toHaveBeenCalledTimes(1);
  });

  it.each(['hover', 'always'] as const)('%s 展开时按钮 active 与自身 check 一起可见，Logo 无 check', async (toolsDisplay) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({expanded: true, toolsDisplay}).page);
    expect(state).toMatchObject({translated: true, translateToolPressed: 'true', check: true,
      mainCheck: false, checkVisible: true, mainOpacity: 1, translateToolOpacity: 1});
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(true);
    expect(floatingCli.isCollapsedFloatingUiState(state, true)).toBe(false);
  });

  it('按同一 reader 顺序观察未开启、开启、恢复、再次开启，不依赖根旧类或外部 check', async () => {
    const fixture = makeFloatingCdpFixture({pressed: 'false', toolCheck: false, legacyRootClass: true});
    const initial = await floatingCli.readFloatingUiState(fixture.page);
    expect(initial).toMatchObject({translated: false, translateToolPressed: 'false', check: false});
    expect(floatingCli.isCollapsedFloatingUiState(initial, false)).toBe(true);
    fixture.replace({pressed: 'true'});
    const active = await floatingCli.readFloatingUiState(fixture.page);
    expect(floatingCli.isCollapsedFloatingUiState(active, true)).toBe(true);
    fixture.replace({pressed: 'false', toolCheck: false});
    const restored = await floatingCli.readFloatingUiState(fixture.page);
    expect(restored).toMatchObject({translated: false, check: false, checkBox: null, checkVisible: false});
    expect(floatingCli.isCollapsedFloatingUiState(restored, false)).toBe(true);
    fixture.replace({pressed: 'true'});
    expect(floatingCli.isCollapsedFloatingUiState(await floatingCli.readFloatingUiState(fixture.page), true)).toBe(true);
    expect(fixture.sessions).toHaveLength(4);
    for (const session of fixture.sessions) expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('展开但未开启时明确 false，不能把 false 字符串误当真', async () => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({expanded: true, pressed: 'false', toolCheck: false}).page);
    expect(state).toMatchObject({translated: false, check: false, checkVisible: false});
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(true);
  });

  it.each([false, true])('expanded=%s 时拒绝品牌主体旧 check，即使正确工具的 active 状态完整', async (expanded) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({expanded, mainCheck: true}).page);
    expect(state).toMatchObject({translated: true, check: true, mainCheck: true});
    expect(floatingCli.isCollapsedFloatingUiState(state, true)).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
  });

  it('仅品牌主体有 check 时 reader 仍报告工具 check 缺失，拒绝拿它顶替', async () => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({mainCheck: true, toolCheck: false}).page);
    expect(state).toMatchObject({translated: true, mainCheck: true, check: false, checkBox: null});
    expect(floatingCli.isCollapsedFloatingUiState(state, true)).toBe(false);
  });

  it.each([null, '', 'TRUE', 'mixed', '1'])('拒绝缺失或非法 aria-pressed=%s，不能当合法 inactive', async (pressed) => {
    for (const expanded of [false, true]) {
      const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({pressed, expanded, toolCheck: false}).page);
      expect(state.translated).toBe(false);
      expect(floatingCli.isCollapsedFloatingUiState(state, false)).toBe(false);
      expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
    }
  });

  it.each([false, true])('expanded=%s 时拒绝 pressed=false 但工具仍有 check 的不同步组合', async (expanded) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({expanded, pressed: 'false'}).page);
    expect(state).toMatchObject({translated: false, check: true});
    expect(floatingCli.isCollapsedFloatingUiState(state, false)).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
  });

  it.each([false, true])('expanded=%s 时拒绝 pressed=true 但工具缺 check', async (expanded) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({expanded, toolCheck: false}).page);
    expect(state).toMatchObject({translated: true, check: false});
    expect(floatingCli.isCollapsedFloatingUiState(state, true)).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
  });

  it.each([
    ['tool opacity', {toolStyle: {opacity: '0'}}],
    ['tool visibility', {toolStyle: {visibility: 'hidden'}}],
    ['tool display', {toolStyle: {display: 'none'}}],
    ['check opacity', {checkStyle: {opacity: '0'}}],
    ['check visibility', {checkStyle: {visibility: 'hidden'}}],
    ['check display', {checkStyle: {display: 'none'}}],
    ['missing box', {checkQuad: null}],
    ['offscreen box', {checkQuad: [-24, 338, -10, 338, -10, 352, -24, 352]}],
  ] as [string, FloatingTreeOptions][])('展开时 %s 不能仅凭 check 存在冒充可见', async (_label, options) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({...options, expanded: true}).page);
    expect(state.check).toBe(true);
    expect(state.checkVisible).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
  });

  it.each([{translateTool: false}, {floatingHost: false}] as FloatingTreeOptions[])('拒绝真正入口缺失，外部同名 check 无法补齐', async (options) => {
    const state = await floatingCli.readFloatingUiState(makeFloatingCdpFixture({...options, pressed: 'false', toolCheck: false}).page);
    expect(state.translateTool).toBe(false);
    expect(floatingCli.isCollapsedFloatingUiState(state, false)).toBe(false);
    expect(floatingCli.isExpandedFloatingUiState(state)).toBe(false);
  });

  it('进度 host 空壳不决定 active；存在 panel 时从另一棵 closed tree 读真实计数', async () => {
    const fixture = makeFloatingCdpFixture({progressPanel: true});
    const state = await floatingCli.readFloatingUiState(fixture.page);
    expect(state.progress).toEqual({running: 2, remaining: 9, queued: 3, offscreen: 6});
    expect(state).toMatchObject({translated: true, progressHost: true, progressPanel: true});
    fixture.replace({pressed: 'false', toolCheck: false});
    const stopped = await floatingCli.readFloatingUiState(fixture.page);
    expect(stopped).toMatchObject({translated: false, progressHost: true, progressPanel: false});
    expect(stopped.progress).toBeNull();
  });

  it('CDP document 读取失败仍 detach 当前 session，不能把失败变成空闲成功', async () => {
    const fixture = makeFloatingCdpFixture();
    const error = new Error('CONTROLLED_CDP_DOCUMENT_FAILURE');
    fixture.failDocument(error);
    await expect(floatingCli.readFloatingUiState(fixture.page)).rejects.toBe(error);
    expect(fixture.sessions[0].detach).toHaveBeenCalledTimes(1);
  });
});

// 只在测试内存副本中访问既有 private waiter；正式 CLI 不增加导出或测试模式。
describe('全文浮动 UI 的 CDP 节点换代采样', () => {
  const missingNodeMessage = 'cdpSession.send: Protocol error (CSS.getComputedStyleForNode): Could not find node with given id';
  function controlledWaiter(fixture: ReturnType<typeof makeFloatingCdpFixture>, onPoll = () => {}) {
    let now = 0;
    const sourcePath = resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs');
    const module = {exports: {}};
    new Script(readFileSync(sourcePath, 'utf8') +
      '\nmodule.exports.__testWaitForFloatingUiState = waitForFloatingUiState;' +
      '\nmodule.exports.__testAssertNoAutomaticFloatingExpansion = assertNoAutomaticFloatingExpansion;',
    {filename: sourcePath}).runInNewContext({module, exports: module.exports,
      require: createRequire(sourcePath), __dirname: dirname(sourcePath), process, console,
      Date: {now: () => now}});
    fixture.page.waitForTimeout.mockImplementation(async milliseconds => {now += milliseconds; onPoll();});
    return {...module.exports as {
      __testWaitForFloatingUiState(page: unknown, predicate: (state: FloatingCliState) => boolean,
        timeout: number, description: string): Promise<FloatingCliState>;
      __testAssertNoAutomaticFloatingExpansion(page: unknown, durationMs?: number): Promise<unknown>;
    }, elapsed: () => now};
  }

  it.each([7, 6, 10])('nodeId=%s 在样式读取前失效时丢弃整样本，下个原50ms轮询重新读完整document', async nodeId => {
    const fixture = makeFloatingCdpFixture({progressPanel: true});
    const stale = new Error(missingNodeMessage);
    fixture.controlStyle(nodeId, async () => {throw stale;});
    const clock = controlledWaiter(fixture, () => {
      fixture.clearStyleReads();
      fixture.replace({progressPanel: true, nodeIdOffset: 100});
    });
    const predicate = vi.fn((state: FloatingCliState) => Boolean(state.progressPanel && state.progress?.running));
    const state = await clock.__testWaitForFloatingUiState(fixture.page, predicate, 125, 'viewport progress');
    expect(state.progress).toEqual({running: 2, remaining: 9, queued: 3, offscreen: 6});
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(predicate).toHaveBeenCalledWith(state);
    expect(fixture.sessions).toHaveLength(2);
    expect(clock.elapsed()).toBe(50);
    expect(fixture.page.waitForTimeout).toHaveBeenCalledOnce();
    expect(fixture.page.waitForTimeout).toHaveBeenCalledWith(50);
    expect(fixture.page.evaluate).toHaveBeenCalledOnce();
    expect(fixture.sessions[0].send).toHaveBeenCalledWith('CSS.getComputedStyleForNode', {nodeId});
    expect(fixture.sessions[1].send).toHaveBeenCalledWith('CSS.getComputedStyleForNode', {nodeId: nodeId + 100});
    for (const session of fixture.sessions) {
      expect(session.send.mock.calls.filter(([method]) => method === 'DOM.getDocument')).toHaveLength(1);
      expect(session.detach).toHaveBeenCalledOnce();
    }
  });

  it('持续失效仍在原deadline退出，既有50ms轮询不能刷新预算或把null样本交给predicate', async () => {
    const fixture = makeFloatingCdpFixture({progressPanel: true});
    fixture.controlStyle(10, async () => {throw new Error(missingNodeMessage);});
    const clock = controlledWaiter(fixture);
    const predicate = vi.fn(() => true);
    await expect(clock.__testWaitForFloatingUiState(fixture.page, predicate, 125, 'stale deadline'))
      .rejects.toThrow('stale deadline：null');
    expect(predicate).not.toHaveBeenCalled();
    expect(clock.elapsed()).toBe(150);
    expect(fixture.sessions).toHaveLength(3);
    expect(fixture.page.waitForTimeout.mock.calls).toEqual([[50], [50], [50]]);
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
    for (const session of fixture.sessions) expect(session.detach).toHaveBeenCalledOnce();
  });

  it('重新读取到完整但不满足原progress条件的状态也必须超时，不能只因刷新成功而PASS', async () => {
    const fixture = makeFloatingCdpFixture({progressPanel: true});
    fixture.controlStyle(10, async () => {throw new Error(missingNodeMessage);});
    const clock = controlledWaiter(fixture, () => {
      fixture.clearStyleReads();
      fixture.replace({progressPanel: false, nodeIdOffset: 100});
    });
    const predicate = vi.fn((state: FloatingCliState) => Boolean(state.progressPanel && state.progress?.running));
    await expect(clock.__testWaitForFloatingUiState(fixture.page, predicate, 100, 'missing progress'))
      .rejects.toThrow('missing progress');
    expect(predicate).toHaveBeenCalledOnce();
    expect(predicate.mock.calls[0][0]).toMatchObject({progressPanel: false, progress: null});
    expect(clock.elapsed()).toBe(100);
    expect(fixture.sessions).toHaveLength(2);
  });

  it.each([
    'cdpSession.send: Protocol error (CSS.getComputedStyleForNode): Target closed',
    'cdpSession.send: Protocol error (DOM.getBoxModel): Could not find node with given id',
    'Could not find node with given id',
    'CONTROLLED_UNKNOWN_CSS_FAILURE',
  ])('未知或非精确CSS失效仍立即抛出同一错误：%s', async message => {
    const fixture = makeFloatingCdpFixture();
    const error = new Error(message);
    fixture.controlStyle(10, async () => {throw error;});
    const clock = controlledWaiter(fixture);
    const predicate = vi.fn(() => true);
    await expect(clock.__testWaitForFloatingUiState(fixture.page, predicate, 125, 'must stay fatal')).rejects.toBe(error);
    expect(predicate).not.toHaveBeenCalled();
    expect(fixture.page.waitForTimeout).not.toHaveBeenCalled();
    expect(fixture.sessions).toHaveLength(1);
    expect(fixture.sessions[0].detach).toHaveBeenCalledOnce();
    expect(clock.elapsed()).toBe(0);
  });

  it('并行样式读取先失效且另一个仍pending时，未知CSS异常仍立即fatal而不被丢弃样本掩盖', async () => {
    const fixture = makeFloatingCdpFixture();
    const stale = new Error(missingNodeMessage);
    const unknown = new Error('CONTROLLED_PARALLEL_CSS_FAILURE');
    let release!: (style: FloatingCdpStyle) => void;
    const pending = new Promise<FloatingCdpStyle>(resolve => {release = resolve;});
    fixture.controlStyle(7, async () => {throw stale;});
    fixture.controlStyle(6, () => pending);
    fixture.controlStyle(10, async () => {throw unknown;});
    const clock = controlledWaiter(fixture);
    const predicate = vi.fn(() => true);
    try {
      await expect(clock.__testWaitForFloatingUiState(fixture.page, predicate, 125, 'parallel error')).rejects.toBe(unknown);
      expect(predicate).not.toHaveBeenCalled();
      expect(fixture.page.waitForTimeout).not.toHaveBeenCalled();
      expect(fixture.sessions[0].detach).toHaveBeenCalledOnce();
    } finally {release({opacity: '0', visibility: 'visible', display: 'flex'});}
  });

  it('document阶段即使抛出相同CSS字串也不是由特定style调用产生的pending状态', async () => {
    const fixture = makeFloatingCdpFixture();
    const error = new Error(missingNodeMessage);
    fixture.failDocument(error);
    const clock = controlledWaiter(fixture);
    await expect(clock.__testWaitForFloatingUiState(fixture.page, () => true, 125, 'document failed')).rejects.toBe(error);
    expect(fixture.page.waitForTimeout).not.toHaveBeenCalled();
    expect(fixture.sessions[0].detach).toHaveBeenCalledOnce();
  });

  it('直接reader与无自动展开观察仍抛出原失效错误，不把空样本计作稳定成功', async () => {
    const fixture = makeFloatingCdpFixture();
    const stale = new Error(missingNodeMessage);
    fixture.controlStyle(10, async () => {throw stale;});
    await expect(floatingCli.readFloatingUiState(fixture.page)).rejects.toBe(stale);
    const clock = controlledWaiter(fixture);
    await expect(clock.__testAssertNoAutomaticFloatingExpansion(fixture.page)).rejects.toBe(stale);
    expect(fixture.page.waitForTimeout).not.toHaveBeenCalled();
    for (const session of fixture.sessions) expect(session.detach).toHaveBeenCalledOnce();
  });
});

describe('固定高度真实 CLI 完成条件', () => {
  const {isFixedHeightTranslationSettled} = require(resolve(PROJECT_ROOT, 'scripts/testing/run-fixed-height-translation-test.cjs')) as {
    isFixedHeightTranslationSettled: (options: {owned: string; sourceSelectors: string[]}) => boolean;
  };

  function createFixedHeightCompletionFixture() {
    const {parseHTML} = require('linkedom') as typeof import('linkedom');
    const {document} = parseHTML(readFileSync(resolve(PROJECT_ROOT, 'tests/fixtures/fixed-height-translation-fixture.html'), 'utf8'));
    const options = {owned: '.fluent-read-bilingual-content', sourceSelectors: ['.model-title', '.model-description', '.model-meta']};
    // 使用实际导出函数的序列化结果，和 page.waitForFunction 一样只提供页面 document 与参数。
    const predicate = new Script(`(${isFixedHeightTranslationSettled.toString()})(options)`);
    const settled = () => predicate.runInNewContext({document, options}, {timeout: 1000}) as boolean;
    const addTranslation = (cardId: string, selector: string) => {
      const wrapper = document.createElement('span');
      wrapper.className = 'fluent-read-bilingual-content';
      wrapper.textContent = '确定性测试译文';
      document.querySelector(`#${cardId} ${selector}`)!.appendChild(wrapper);
      return wrapper;
    };
    const complete = () => {
      for (const id of ['card-a', 'card-b', 'card-c']) {
        for (const selector of options.sourceSelectors) addTranslation(id, selector);
      }
    };
    return {document, options, settled, addTranslation, complete};
  }

  it('没有 spinner 的零译文或首个译文阶段都不是完成', () => {
    const fixture = createFixedHeightCompletionFixture();
    expect(fixture.settled()).toBe(false);
    fixture.addTranslation('card-a', '.model-title');
    expect(fixture.document.querySelector('.fluent-read-loading, .fluent-read-retry-wrapper')).toBeNull();
    expect(fixture.settled()).toBe(false);
  });

  it('拒绝 3/3/2 的延迟 spinner 空窗，直到 card-c meta 的第九个译文真正插入', () => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    const meta = fixture.document.querySelector('#card-c .model-meta')!;
    meta.querySelector(fixture.options.owned)!.remove();
    expect(fixture.document.querySelectorAll(fixture.options.owned)).toHaveLength(8);
    expect(fixture.document.querySelector('.fluent-read-loading, .fluent-read-retry-wrapper')).toBeNull();
    expect(fixture.settled()).toBe(false);
    meta.classList.add('fluent-read-loading');
    expect(fixture.settled()).toBe(false);
    meta.classList.remove('fluent-read-loading');
    fixture.addTranslation('card-c', '.model-meta');
    expect(fixture.document.querySelectorAll(fixture.options.owned)).toHaveLength(9);
    expect(fixture.settled()).toBe(true);
  });

  it('九个独立文本槽都完成时返回 true，读取不改变页面', () => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    const before = fixture.document.documentElement.outerHTML;
    expect(fixture.settled()).toBe(true);
    expect(fixture.document.documentElement.outerHTML).toBe(before);
  });

  it('全局九个译文分布为 4/3/2 时仍拒绝', () => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    fixture.document.querySelector('#card-c .model-meta')!.querySelector(fixture.options.owned)!.remove();
    fixture.addTranslation('card-a', '.model-title');
    expect(fixture.document.querySelectorAll(fixture.options.owned)).toHaveLength(9);
    expect(fixture.settled()).toBe(false);
  });

  it('每卡三个译文但 card-c title 重复而 meta 缺失时仍拒绝', () => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    fixture.document.querySelector('#card-c .model-meta')!.querySelector(fixture.options.owned)!.remove();
    fixture.addTranslation('card-c', '.model-title');
    expect([...fixture.document.querySelectorAll('.model-card')].map(card => card.querySelectorAll(fixture.options.owned).length)).toEqual([3, 3, 3]);
    expect(fixture.settled()).toBe(false);
  });

  it('九个原文本槽完成但另有额外译文时仍拒绝，不能冒充原限定的九个', () => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    const extra = fixture.document.createElement('span');
    extra.className = 'fluent-read-bilingual-content';
    fixture.document.body.appendChild(extra);
    expect(fixture.document.querySelectorAll(fixture.options.owned)).toHaveLength(10);
    expect(fixture.settled()).toBe(false);
    extra.remove();
    expect(fixture.settled()).toBe(true);
  });

  it.each(['fluent-read-loading', 'fluent-read-retry-wrapper'])('九个译文已有但仍存在 %s 时拒绝', className => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    const pending = fixture.document.createElement('span');
    pending.className = className;
    fixture.document.body.appendChild(pending);
    expect(fixture.settled()).toBe(false);
    pending.remove();
    expect(fixture.settled()).toBe(true);
  });

  it.each(['missing', 'extra'] as const)('卡片数量 %s 时不能以已有译文冒充完整夹具', mode => {
    const fixture = createFixedHeightCompletionFixture();
    fixture.complete();
    const card = fixture.document.querySelector('#card-c')!;
    if (mode === 'missing') card.remove();
    else fixture.document.body.appendChild(card.cloneNode(true));
    expect(fixture.settled()).toBe(false);
  });
});

// APPEND ONLY: unchanged-attribute request baseline; no browser, server, or native port.
type UnchangedBaselinePage = {
  waitForFunction(predicate: () => boolean, arg: undefined, options: {timeout: number}): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};
const unchangedBaselineCli = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs')) as {
  waitForUnchangedAttributeBaseline(page: UnchangedBaselinePage, server: {requestCount(): number}, timeout: number): Promise<number>;
  assertUnchangedAttributeStability(evidence: object): void;
};

function makeUnchangedBaselineHarness(options: {loadingMs?: number; lateRequestAt?: number; continuous?: boolean} = {}) {
  let now = 0;
  let count = 40;
  const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const requestCount = vi.fn(() => count);
  const page = {
    // Model a successfully observed loading-free gap before a queued request reaches HTTP.
    waitForFunction: vi.fn(async (_predicate: () => boolean, _arg: undefined, _settings: {timeout: number}) => {
      now += options.loadingMs ?? 300;
    }),
    waitForTimeout: vi.fn(async (ms: number) => {
      now += ms;
      if (options.continuous) count += 1;
      else if (options.lateRequestAt !== undefined && now >= options.lateRequestAt) count = 41;
    }),
  };
  return {page, server: {requestCount}, now: () => now, increment: () => ++count, restore: () => nowSpy.mockRestore()};
}

function stableUnchangedBaselineEvidence(beforeRequests: number, afterRequests: number, requestPayloads: string[][] = []) {
  const target = {sameOwner: true, sameSlots: true, htmlStable: true, domMutations: 0,
    invalidPaintFrames: 0, maxGeometryDelta: 0};
  return {beforeRequests, afterRequests, requestPayloads, paintFrames: 24, targets: [target, target]};
}

describe('同值属性探针请求基线准备', () => {
  it('loading 空窗后的迟到队列请求须先静默，才能冻结全局基线', async () => {
    const harness = makeUnchangedBaselineHarness({lateRequestAt: 600});
    try {
      const baseline = await unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 2000);
      expect(baseline).toBe(41);
      expect(harness.now()).toBe(1800); // late dispatch at 600 + unchanged 1200ms quiet window.
      expect(harness.page.waitForFunction.mock.calls[0][2]).toEqual({timeout: 2000});
      expect(() => unchangedBaselineCli.assertUnchangedAttributeStability(
        stableUnchangedBaselineEvidence(baseline, harness.server.requestCount()),
      )).not.toThrow();
    } finally {harness.restore();}
  });

  it.each([
    ['target-repeat', 'The second paragraph changed after full-page translation.'],
    ['unrelated-queue', 'Offscreen paragraph 59 remains pending until the reader scrolls near this part of the document.'],
  ])('测量窗口内 %s 新请求仍严格失败，即使目标 DOM 完全稳定', async (_kind, text) => {
    const harness = makeUnchangedBaselineHarness();
    try {
      const baseline = await unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 2000);
      const after = harness.increment();
      const evidence = stableUnchangedBaselineEvidence(baseline, after, [[text]]);
      expect(() => unchangedBaselineCli.assertUnchangedAttributeStability(evidence))
        .toThrow('同值属性写入重建了已完成的单译文或控件');
      expect(() => unchangedBaselineCli.assertUnchangedAttributeStability(evidence)).toThrow(text);
    } finally {harness.restore();}
  });

  it('持续请求耗尽同一准备预算时失败，不能另开一次完整 timeout', async () => {
    const harness = makeUnchangedBaselineHarness({continuous: true});
    try {
      await expect(unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 1950))
        .rejects.toThrow('等待翻译请求静默超时');
      expect(harness.now()).toBe(1950);
      expect(harness.page.waitForTimeout).toHaveBeenCalledTimes(11);
    } finally {harness.restore();}
  });

  it('loading 等待已耗尽原预算时不再等待静默', async () => {
    const harness = makeUnchangedBaselineHarness({loadingMs: 2000});
    try {
      await expect(unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 2000))
        .rejects.toThrow('等待同值属性请求基线超时');
      expect(harness.page.waitForTimeout).not.toHaveBeenCalled();
      expect(harness.server.requestCount).not.toHaveBeenCalled();
    } finally {harness.restore();}
  });

  it('轮询越过预算后才满足静默不能当作成功', async () => {
    const harness = makeUnchangedBaselineHarness();
    try {
      await expect(unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 1400))
        .rejects.toThrow('等待同值属性请求基线超时');
      expect(harness.now()).toBe(1500); // Existing 150ms polling can overshoot; it must fail.
    } finally {harness.restore();}
  });

  it('loading 条件失败直接传播，不能冻结伪基线', async () => {
    const harness = makeUnchangedBaselineHarness();
    const error = new Error('CONTROLLED_LOADING_TIMEOUT');
    harness.page.waitForFunction.mockRejectedValueOnce(error);
    try {
      await expect(unchangedBaselineCli.waitForUnchangedAttributeBaseline(harness.page, harness.server, 2000))
        .rejects.toBe(error);
      expect(harness.page.waitForTimeout).not.toHaveBeenCalled();
      expect(harness.server.requestCount).not.toHaveBeenCalled();
    } finally {harness.restore();}
  });
});

// Append only this block to tests/browserFocusSafety.test.ts after the CLI patch.
// Uses that file's existing ts, Script, require, readScript and Vitest imports.
// Evaluate actual CLI declarations with DOM ports; never invoke main or launch a browser.
type VideoFixtureSettingsState = {
  checked: string | null;
  disabled: boolean | null;
  summary: string;
  betaMarkers: number;
  modes: {label: string; checked: string | null; disabled: boolean}[];
};
type VideoFixtureStoredState = {
  videoTranslationEnabled: boolean;
  videoSubtitleVisible: boolean;
  videoSubtitleDisplayMode: string;
};

type VideoFixtureStorageReadRequest = {type: string; key: string};
type VideoFixtureStorageReadResponse = {success?: boolean; value?: Record<string, unknown> | string | null; error?: string};
type VideoFixtureAsyncWaitOptions = {timeoutMs: number; pollingMs?: number; message?: string};

function videoFixtureContractHarness(options: {
  readStorage?: (request: VideoFixtureStorageReadRequest) => Promise<VideoFixtureStorageReadResponse>;
} = {}) {
  const {parseHTML} = require('linkedom') as typeof import('linkedom');
  const {document} = parseHTML(`<html><body>
    <button role="switch" aria-checked="false">Unrelated switch</button>
    <button data-feature="video-subtitle"><i class="active"></i><small>Obsolete Popup card</small></button>
    <section id="settings-video">
      <div class="feature-enable-card">
        <button role="switch" aria-label="视频字幕翻译" aria-checked="true">
          <span class="feature-enable-heading">视频字幕翻译</span>
          <span class="feature-enable-description">翻译视频与网页会议字幕，不上传音频或视频内容</span>
        </button>
      </div>
      <div role="radiogroup" aria-label="字幕皮肤"><button role="radio" aria-checked="true">经典</button></div>
      <div role="radiogroup" aria-label="视频字幕显示模式">
        <button role="radio" aria-checked="true"> 双语 </button>
        <button role="radio" aria-checked="false"> 仅译文 </button>
        <button role="radio" aria-checked="false"> 仅原文 </button>
      </div>
    </section>
  </body></html>`);
  const filename = 'scripts/run-video-subtitle-fixture-test.cjs';
  const ast = ts.createSourceFile(filename, readScript(filename), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ['readVideoSettingsState', 'assertEnabledVideoSettingsState', 'readExtensionConfig',
    'waitForVideoDisplayModePersistence'].map((name) => {
    const matches = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error(`Expected one actual video fixture declaration: ${name}`);
    return matches[0].getText(ast);
  }).join('\n');
  const documentWaitCalls = descendantNodes(ast).filter((node): node is ts.AwaitExpression => {
    if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== 'waitForAsyncCondition') return false;
    return descendantNodes(node.expression.arguments[0]).some((child) => ts.isCallExpression(child)
      && ts.isPropertyAccessExpression(child.expression) && ts.isIdentifier(child.expression.expression)
      && child.expression.expression.text === 'documentConfigPage' && child.expression.name.text === 'evaluate');
  });
  if (documentWaitCalls.length !== 1) throw new Error('Expected one actual document config async wait call');
  // Wrap the exact inline call, including its browser predicate and 10000ms options.
  // Do not invoke main or reconstruct the document predicate in the test.
  const documentWaitDeclaration = `async function waitForDocumentConfigPersistence(documentConfigPage) {
    ${documentWaitCalls[0].getText(ast)};
  }`;
  const sendMessage = vi.fn(options.readStorage ?? (async (request: VideoFixtureStorageReadRequest) => ({
    success: true, value: request.key === 'local:config' ? stored : {},
  })));
  // Mock protocol only: execute the actual shared Node waiter and actual AST
  // storage reader. Only page.evaluate / runtime messaging are controlled ports;
  // no replacement polling implementation, Playwright execution or browser proof.
  const {waitForAsyncCondition} = require(resolve(PROJECT_ROOT, 'scripts/testing/wait-for-async-condition.cjs')) as {
    waitForAsyncCondition(predicate: () => Promise<unknown>, settings: VideoFixtureAsyncWaitOptions): Promise<void>;
  };
  const waitForCondition = vi.fn(waitForAsyncCondition);
  const helpers = new Script(`${declarations}\n${documentWaitDeclaration}\n({readVideoSettingsState, assertEnabledVideoSettingsState, readExtensionConfig, waitForVideoDisplayModePersistence, waitForDocumentConfigPersistence});`,
    {filename: 'video-fixture-actual-contract.cjs'}).runInNewContext({document,
      chrome: {runtime: {sendMessage}}, waitForAsyncCondition: waitForCondition}, {timeout: 1000}) as {
      readVideoSettingsState(page: {evaluate: (fn: () => unknown) => Promise<unknown>}): Promise<VideoFixtureSettingsState>;
      assertEnabledVideoSettingsState(state: VideoFixtureSettingsState, stored: VideoFixtureStoredState, expectedMode?: string): void;
      readExtensionConfig(page: {evaluate: (fn: () => unknown) => Promise<unknown>}): Promise<VideoFixtureStoredState>;
      waitForVideoDisplayModePersistence(page: {evaluate: (fn: () => unknown) => Promise<unknown>}, expectedMode: string): Promise<void>;
      waitForDocumentConfigPersistence(page: {evaluate: (fn: () => unknown) => Promise<unknown>}): Promise<void>;
    };
  const page = {evaluate: vi.fn(async (fn: () => unknown) => fn())};
  const stored: VideoFixtureStoredState = {
    videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual',
  };
  return {document, page, stored, helpers, sendMessage, waitForCondition};
}

describe('视频字幕 fixture 的当前设置入口与持久配置契约', () => {
  it('以生产构造和归一化验证开启/可见/双语默认，并保留用户显式关闭与原文偏好', async () => {
    const {Config, normalizeConfig} = await import('@/src/core/config/model');
    const defaults = {
      videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual',
    };
    expect(new Config()).toMatchObject(defaults);
    expect(normalizeConfig({})).toMatchObject(defaults);
    expect(normalizeConfig({videoTranslationEnabled: false, videoSubtitleVisible: false,
      videoSubtitleDisplayMode: 'original-only'})).toMatchObject({
      videoTranslationEnabled: false, videoSubtitleVisible: false, videoSubtitleDisplayMode: 'original-only',
    });
  });

  it('读取实际设置开关与三模式，忽略旧 Popup 卡片及其他开关/皮肤组', async () => {
    const h = videoFixtureContractHarness();
    const state = await h.helpers.readVideoSettingsState(h.page);
    expect(state).toEqual({checked: 'true', disabled: false, betaMarkers: 0,
      summary: '翻译视频与网页会议字幕，不上传音频或视频内容', modes: [
        {label: '双语', checked: 'true', disabled: false},
        {label: '仅译文', checked: 'false', disabled: false},
        {label: '仅原文', checked: 'false', disabled: false},
      ]});
    expect(() => h.helpers.assertEnabledVideoSettingsState(state, h.stored)).not.toThrow();
  });

  it('移除实际开关时返回缺失值并失败，旧卡片 active 不能掩盖入口缺失', async () => {
    const h = videoFixtureContractHarness();
    h.document.querySelector('#settings-video .feature-enable-card')!.remove();
    const state = await h.helpers.readVideoSettingsState(h.page);
    expect(state.checked).toBeNull();
    expect(state.disabled).toBeNull();
    expect(() => h.helpers.assertEnabledVideoSettingsState(state, h.stored)).toThrow('视频字幕设置与持久配置不一致');
  });

  it('拒绝 UI 乐观开启而持久开关关闭、字幕隐藏或持久模式落后的状态', async () => {
    const h = videoFixtureContractHarness();
    const state = await h.helpers.readVideoSettingsState(h.page);
    for (const patch of [{videoTranslationEnabled: false}, {videoSubtitleVisible: false},
      {videoSubtitleDisplayMode: 'translation-only'}]) {
      expect(() => h.helpers.assertEnabledVideoSettingsState(state, {...h.stored, ...patch})).toThrow('视频字幕设置与持久配置不一致');
    }
    h.document.querySelector('#settings-video [role="switch"]')!.setAttribute('aria-checked', 'false');
    const disabledState = await h.helpers.readVideoSettingsState(h.page);
    expect(disabledState.checked).toBe('false');
    expect(() => h.helpers.assertEnabledVideoSettingsState(disabledState, h.stored)).toThrow('视频字幕设置与持久配置不一致');
  });

  it('仅译文与原文模式必须对应同一真实 radio 和同一持久值，之后可恢复双语', async () => {
    const h = videoFixtureContractHarness();
    const radios = [...h.document.querySelectorAll('#settings-video [aria-label="视频字幕显示模式"] [role="radio"]')];
    for (const [mode, selectedIndex] of [['translation-only', 1], ['original-only', 2], ['bilingual', 0]] as const) {
      radios.forEach((radio, index) => radio.setAttribute('aria-checked', String(index === selectedIndex)));
      const state = await h.helpers.readVideoSettingsState(h.page);
      expect(() => h.helpers.assertEnabledVideoSettingsState(state,
        {...h.stored, videoSubtitleDisplayMode: mode}, mode)).not.toThrow();
      expect(() => h.helpers.assertEnabledVideoSettingsState(state,
        {...h.stored, videoSubtitleDisplayMode: mode}, 'off')).toThrow('视频字幕设置与持久配置不一致');
    }
  });

  it('拒绝缺失/多余/重复选中的模式、不可操作控件及空说明或 Beta 标记', async () => {
    const groupSelector = '#settings-video [aria-label="视频字幕显示模式"]';
    const mutations: ((document: ReturnType<typeof videoFixtureContractHarness>['document']) => void)[] = [
      (document) => {document.querySelector(`${groupSelector} [role="radio"]`)!.remove();},
      (document) => {document.querySelector(groupSelector)!.innerHTML += '<button role="radio" aria-checked="false">关闭</button>';},
      (document) => {document.querySelectorAll(`${groupSelector} [role="radio"]`).forEach((radio) => radio.setAttribute('aria-checked', 'true'));},
      (document) => {document.querySelector(`${groupSelector} [role="radio"]`)!.setAttribute('disabled', '');},
      (document) => {document.querySelector('#settings-video [role="switch"]')!.removeAttribute('aria-checked');},
      (document) => {document.querySelector('#settings-video [role="switch"]')!.setAttribute('disabled', '');},
      (document) => {document.querySelector('.feature-enable-description')!.textContent = '  ';},
      (document) => {document.querySelector('.feature-enable-heading')!.textContent += ' Beta';},
    ];
    for (const mutation of mutations) {
      const h = videoFixtureContractHarness();
      mutation(h.document);
      const state = await h.helpers.readVideoSettingsState(h.page);
      expect(() => h.helpers.assertEnabledVideoSettingsState(state, h.stored)).toThrow('视频字幕设置与持久配置不一致');
    }
  });
});

async function withVideoPersistenceClock(run: () => Promise<void>) {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
  try {await run();} finally {vi.clearAllTimers(); vi.useRealTimers();}
}

function observeVideoPersistenceWait(h: ReturnType<typeof videoFixtureContractHarness>, mode: string) {
  const settled = vi.fn();
  const waiting = h.helpers.waitForVideoDisplayModePersistence(h.page, mode)
    .then(() => {settled('resolved');}, (error) => {settled('rejected', error);});
  return {settled, waiting};
}

function expectVideoPersistenceTimeout(observation: ReturnType<typeof observeVideoPersistenceWait>, mode = 'translation-only') {
  expect(observation.settled.mock.calls).toEqual([['rejected', expect.objectContaining({
    message: `字幕模式未持久化为 ${mode} (5000ms)`,
  })]]);
}

function expectVideoPersistenceBudget(h: ReturnType<typeof videoFixtureContractHarness>, mode = 'translation-only') {
  expect(h.waitForCondition.mock.calls).toEqual([[expect.any(Function), {
    timeoutMs: 5000, message: `字幕模式未持久化为 ${mode}`,
  }]]);
}

describe('字幕模式持久化等待（实际 Node helper，mock protocol only）', () => {
  it.each([
    ['object', 'translation-only', 1], ['string', 'translation-only', 1],
    ['object', 'bilingual', 0], ['string', 'bilingual', 0],
  ] as const)('%s 首次 false 后反复读取，450ms 持久化 %s，525ms 异步结果返回后才 resolve',
    (encoding, mode, selectedIndex) => withVideoPersistenceClock(async () => {
      const h = videoFixtureContractHarness({readStorage: async (request) => {
        if (request.key !== 'local:config') return {success: true, value: {}};
        await new Promise<void>((resolveRead) => setTimeout(resolveRead, 25));
        return {success: true, value: encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored}};
      }});
      h.stored.videoSubtitleDisplayMode = mode === 'bilingual' ? 'translation-only' : 'bilingual';
      const configReads = () => h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config');
      const radios = [...h.document.querySelectorAll('#settings-video [aria-label="视频字幕显示模式"] [role="radio"]')];
      radios.forEach((radio, index) => radio.setAttribute('aria-checked', String(index === selectedIndex)));
      const optimisticState = await h.helpers.readVideoSettingsState(h.page);
      expect(() => h.helpers.assertEnabledVideoSettingsState(optimisticState, h.stored, mode))
        .toThrow('视频字幕设置与持久配置不一致');
      setTimeout(() => {h.stored.videoSubtitleDisplayMode = mode;}, 450);
      const observation = observeVideoPersistenceWait(h, mode);
      await vi.advanceTimersByTimeAsync(25);
      expect(observation.settled).not.toHaveBeenCalled(); // First completed async predicate returned false.
      expect(configReads()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(325);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.stored.videoSubtitleDisplayMode).not.toBe(mode);
      expect(configReads()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.stored.videoSubtitleDisplayMode).toBe(mode);
      expect(observation.settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(74);
      expect(observation.settled).not.toHaveBeenCalled(); // Fifth read began at 500ms, but is not fulfilled yet.
      expect(configReads()).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(observation.settled.mock.calls).toEqual([['resolved']]);
      await observation.waiting;
      expectVideoPersistenceBudget(h, mode);
      expect(configReads()).toEqual(Array.from({length: 5}, () => [{type: 'configStorageRead', key: 'local:config'}]));
      expect(vi.getTimerCount()).toBe(0);
      // Keep the complete original UI assertion, with a fresh actual storage read after the wait.
      const reread = h.helpers.readExtensionConfig(h.page);
      await vi.advanceTimersByTimeAsync(25);
      const persisted = await reread;
      const state = await h.helpers.readVideoSettingsState(h.page);
      expect(() => h.helpers.assertEnabledVideoSettingsState(state, persisted, mode)).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each(['object', 'string'] as const)('%s 永久 stale 即使 UI 已选中也必须在原 5 秒预算失败',
    (encoding) => withVideoPersistenceClock(async () => {
      const h = videoFixtureContractHarness({readStorage: async (request) => ({success: true,
        value: request.key !== 'local:config' ? {} : encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored},
      })});
      h.document.querySelectorAll('#settings-video [aria-label="视频字幕显示模式"] [role="radio"]')
        .forEach((radio, index) => radio.setAttribute('aria-checked', String(index === 1)));
      const observation = observeVideoPersistenceWait(h, 'translation-only');
      await vi.advanceTimersByTimeAsync(4999);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config')).toHaveLength(50);
      await vi.advanceTimersByTimeAsync(1);
      expectVideoPersistenceTimeout(observation);
      await observation.waiting;
      expectVideoPersistenceBudget(h);
      expect(h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config')).toHaveLength(50);
      expect(h.stored.videoSubtitleDisplayMode).toBe('bilingual');
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each([
    ['后台 success:false 带错误', {success: false, error: 'CONTROLLED_CONFIG_STORAGE_READ_FAILED'}, 'CONTROLLED_CONFIG_STORAGE_READ_FAILED'],
    ['后台 success:false 无错误', {success: false}, '后台配置读取失败：local:config'],
    ['后台未确认 success', {}, '后台配置读取失败：local:config'],
  ] as const)('%s 即使返回 expected 值也不能假 PASS',
    (_label, response, message) => withVideoPersistenceClock(async () => {
      const h = videoFixtureContractHarness({readStorage: async () => ({...response, value: {...h.stored}})});
      const observation = observeVideoPersistenceWait(h, 'bilingual');
      await vi.advanceTimersByTimeAsync(0);
      expect(observation.settled.mock.calls).toEqual([['rejected', expect.objectContaining({message})]]);
      await observation.waiting;
      expect(h.sendMessage.mock.calls).toEqual([[{type: 'configStorageRead', key: 'local:config'}]]);
      expectVideoPersistenceBudget(h, 'bilingual');
      expect(vi.getTimerCount()).toBe(0);
    }));

  it('异步 storage RPC 拒绝传播原错误并停止轮询', () => withVideoPersistenceClock(async () => {
    const error = new Error('CONTROLLED_CONFIG_STORAGE_RPC_REJECTED');
    const h = videoFixtureContractHarness({readStorage: async () => {throw error;}});
    const observation = observeVideoPersistenceWait(h, 'translation-only');
    await vi.advanceTimersByTimeAsync(0);
    expect(observation.settled.mock.calls).toEqual([['rejected', error]]);
    await observation.waiting;
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }));

  it('损坏的字符串存储经实际 reader 归一化为空，必须保持 stale 到超时', () => withVideoPersistenceClock(async () => {
    const h = videoFixtureContractHarness({readStorage: async (request) => ({success: true,
      value: request.key === 'local:config' ? '{invalid-storage-json' : {},
    })});
    const observation = observeVideoPersistenceWait(h, 'bilingual');
    await vi.advanceTimersByTimeAsync(4999);
    expect(observation.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expectVideoPersistenceTimeout(observation, 'bilingual');
    await observation.waiting;
    expect(vi.getTimerCount()).toBe(0);
  }));

  it.each([
    ['object', 0], ['string', 0], ['object', 4800], ['string', 4800],
  ] as const)('%s 在 %sms 开始异步 hung 仍耗尽同一个 5 秒预算，迟到 expected 不能改判',
    (encoding, hungAt) => withVideoPersistenceClock(async () => {
      const started = performance.now();
      let resolveHungRead: ((response: VideoFixtureStorageReadResponse) => void) | undefined;
      const h = videoFixtureContractHarness({readStorage: async (request) => {
        if (request.key !== 'local:config') return {success: true, value: {}};
        if (performance.now() - started < hungAt) {
          return {success: true, value: encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored}};
        }
        return new Promise<VideoFixtureStorageReadResponse>((resolveRead) => {resolveHungRead = resolveRead;});
      }});
      const observation = observeVideoPersistenceWait(h, 'translation-only');
      await vi.advanceTimersByTimeAsync(4999);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(resolveHungRead).toBeTypeOf('function');
      const readsAtDeadline = hungAt / 100 + 1;
      expect(h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config')).toHaveLength(readsAtDeadline);
      await vi.advanceTimersByTimeAsync(1);
      expectVideoPersistenceTimeout(observation);
      await observation.waiting;
      expectVideoPersistenceBudget(h);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      h.stored.videoSubtitleDisplayMode = 'translation-only';
      resolveHungRead!({success: true, value: encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored}});
      await vi.advanceTimersByTimeAsync(0);
      expectVideoPersistenceTimeout(observation);
      expect(h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config')).toHaveLength(readsAtDeadline);
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each(['object', 'string'] as const)('%s config 已命中但后续 credentials 读取 hung 仍不能假 PASS',
    (encoding) => withVideoPersistenceClock(async () => {
      const h = videoFixtureContractHarness({readStorage: async (request) => {
        if (request.key === 'local:credentials') return new Promise<VideoFixtureStorageReadResponse>(() => {});
        return {success: true, value: encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored}};
      }});
      const observation = observeVideoPersistenceWait(h, 'bilingual');
      await vi.advanceTimersByTimeAsync(4999);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage.mock.calls).toEqual([
        [{type: 'configStorageRead', key: 'local:config'}], [{type: 'configStorageRead', key: 'local:credentials'}],
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expectVideoPersistenceTimeout(observation, 'bilingual');
      await observation.waiting;
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each([
    ['object', 5000], ['string', 5000], ['object', 5001], ['string', 5001],
  ] as const)('%s expected 在单调时钟 %sms 才返回，即使 timeout 回调未执行也必须失败',
    (encoding, resultAt) => withVideoPersistenceClock(async () => {
      // A blocked event loop may return a value before its overdue timer executes.
      // Advance the monotonic clock in the actual storage port, without firing that timer.
      const now = vi.spyOn(performance, 'now').mockReturnValue(0);
      try {
        const h = videoFixtureContractHarness({readStorage: async (request) => {
          if (request.key !== 'local:config') return {success: true, value: {}};
          now.mockReturnValue(resultAt);
          return {success: true, value: encoding === 'string' ? JSON.stringify(h.stored) : {...h.stored}};
        }});
        const observation = observeVideoPersistenceWait(h, 'bilingual');
        await vi.advanceTimersByTimeAsync(0);
        expectVideoPersistenceTimeout(observation, 'bilingual');
        await observation.waiting;
        expect(h.sendMessage).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {now.mockRestore();}
    }));

  it('4990ms 才返回 false 时轮询只等待剩余 10ms，不能多等 100ms 或重开预算', () => withVideoPersistenceClock(async () => {
    const h = videoFixtureContractHarness({readStorage: async (request) => {
      if (request.key !== 'local:config') return {success: true, value: {}};
      await new Promise<void>((resolveRead) => setTimeout(resolveRead, 4990));
      return {success: true, value: {...h.stored}};
    }});
    const observation = observeVideoPersistenceWait(h, 'translation-only');
    await vi.advanceTimersByTimeAsync(4999);
    expect(observation.settled).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.filter(([request]) => request.key === 'local:config')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expectVideoPersistenceTimeout(observation);
    await observation.waiting;
    expect(vi.getTimerCount()).toBe(0);
  }));

  it('hung 超时后的迟到 RPC 拒绝不产生成功或未处理拒绝，也不重新轮询', () => withVideoPersistenceClock(async () => {
    let rejectHungRead: ((error: Error) => void) | undefined;
    const h = videoFixtureContractHarness({readStorage: () => new Promise<VideoFixtureStorageReadResponse>(
      (_resolveRead, rejectRead) => {rejectHungRead = rejectRead;},
    )});
    const observation = observeVideoPersistenceWait(h, 'translation-only');
    await vi.advanceTimersByTimeAsync(5000);
    expectVideoPersistenceTimeout(observation);
    await observation.waiting;
    expect(rejectHungRead).toBeTypeOf('function');
    rejectHungRead!(new Error('CONTROLLED_LATE_RPC_REJECTED'));
    await vi.advanceTimersByTimeAsync(1000);
    expectVideoPersistenceTimeout(observation);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }));
});

function observeDocumentConfigWait(h: ReturnType<typeof videoFixtureContractHarness>) {
  const settled = vi.fn();
  const waiting = h.helpers.waitForDocumentConfigPersistence(h.page)
    .then(() => {settled('resolved');}, (error) => {settled('rejected', error);});
  return {settled, waiting};
}

function expectDocumentConfigBudget(h: ReturnType<typeof videoFixtureContractHarness>) {
  expect(h.waitForCondition.mock.calls).toEqual([[expect.any(Function), {
    timeoutMs: 10000, message: '文档源语言与字幕开关未持久化',
  }]]);
}

function expectDocumentConfigTimeout(observation: ReturnType<typeof observeDocumentConfigWait>) {
  expect(observation.settled.mock.calls).toEqual([['rejected', expect.objectContaining({
    message: '文档源语言与字幕开关未持久化 (10000ms)',
  })]]);
}

describe('文档配置持久化等待（实际调用，mock protocol only）', () => {
  it.each([
    ['object', 'auto', true], ['string', 'auto', true],
    ['object', 'en', false], ['string', 'en', false],
  ] as const)('%s 首次 from=%s/enabled=%s 返回 false，450ms 两字段都持久化后才 resolve',
    (encoding, from, videoTranslationEnabled) => withVideoPersistenceClock(async () => {
      const stored = {from: from as string, videoTranslationEnabled: videoTranslationEnabled as boolean};
      const h = videoFixtureContractHarness({readStorage: async () => {
        await new Promise<void>((resolveRead) => setTimeout(resolveRead, 25));
        return {success: true, value: encoding === 'string' ? JSON.stringify(stored) : {...stored}};
      }});
      setTimeout(() => {stored.from = 'en'; stored.videoTranslationEnabled = true;}, 450);
      const observation = observeDocumentConfigWait(h);
      await vi.advanceTimersByTimeAsync(25);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(325);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(174);
      expect(stored).toEqual({from: 'en', videoTranslationEnabled: true});
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(observation.settled.mock.calls).toEqual([['resolved']]);
      await observation.waiting;
      expectDocumentConfigBudget(h);
      expect(h.sendMessage.mock.calls).toEqual(Array.from({length: 5}, () => [{type: 'configStorageRead', key: 'local:config'}]));
      expect(h.page.evaluate).toHaveBeenCalledTimes(5);
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each([
    ['success:false 带原错误', {success: false, error: 'CONTROLLED_DOCUMENT_STORAGE_READ_FAILED'}, 'CONTROLLED_DOCUMENT_STORAGE_READ_FAILED'],
    ['success:false 无错误', {success: false}, '后台配置读取失败：local:config'],
    ['未确认 success', {}, '后台配置读取失败：local:config'],
  ] as const)('%s 立即失败，expected 字段不能掩盖错误或被变成 10 秒超时',
    (_label, response, message) => withVideoPersistenceClock(async () => {
      const h = videoFixtureContractHarness({readStorage: async () => ({...response,
        value: {from: 'en', videoTranslationEnabled: true},
      })});
      const observation = observeDocumentConfigWait(h);
      await vi.advanceTimersByTimeAsync(0);
      expect(observation.settled.mock.calls).toEqual([['rejected', expect.objectContaining({message})]]);
      await observation.waiting;
      expect(performance.now()).toBe(0);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expectDocumentConfigBudget(h);
      expect(vi.getTimerCount()).toBe(0);
    }));

  it('实际 document 调用保留异步消息 rejection 的同一个 Error，立即停止', () => withVideoPersistenceClock(async () => {
    const error = new Error('CONTROLLED_DOCUMENT_RPC_REJECTED');
    const h = videoFixtureContractHarness({readStorage: async () => {throw error;}});
    const observation = observeDocumentConfigWait(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(observation.settled.mock.calls).toEqual([['rejected', error]]);
    await observation.waiting;
    expect(performance.now()).toBe(0);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }));

  it('document 的非法 JSON 字符串立即保留 parse 错误，不能默默轮询到 deadline', () => withVideoPersistenceClock(async () => {
    const h = videoFixtureContractHarness({readStorage: async () => ({success: true, value: '{invalid-document-json'})});
    const observation = observeDocumentConfigWait(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(observation.settled.mock.calls).toEqual([['rejected', expect.objectContaining({name: 'SyntaxError'})]]);
    await observation.waiting;
    expect(performance.now()).toBe(0);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }));

  it.each(['object', 'string'] as const)('%s 永久 enabled=false 使用完整原 10 秒预算且不能假 PASS',
    (encoding) => withVideoPersistenceClock(async () => {
      const value = {from: 'en', videoTranslationEnabled: false};
      const h = videoFixtureContractHarness({readStorage: async () => ({success: true,
        value: encoding === 'string' ? JSON.stringify(value) : {...value},
      })});
      const observation = observeDocumentConfigWait(h);
      await vi.advanceTimersByTimeAsync(9999);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(100);
      await vi.advanceTimersByTimeAsync(1);
      expectDocumentConfigTimeout(observation);
      await observation.waiting;
      expectDocumentConfigBudget(h);
      expect(h.sendMessage).toHaveBeenCalledTimes(100);
      expect(vi.getTimerCount()).toBe(0);
    }));

  it.each(['object', 'string'] as const)('%s document 首次 hung 在 10 秒失败，迟到 expected 不改判',
    (encoding) => withVideoPersistenceClock(async () => {
      let resolveHungRead: ((response: VideoFixtureStorageReadResponse) => void) | undefined;
      const h = videoFixtureContractHarness({readStorage: () => new Promise<VideoFixtureStorageReadResponse>(
        (resolveRead) => {resolveHungRead = resolveRead;},
      )});
      const observation = observeDocumentConfigWait(h);
      await vi.advanceTimersByTimeAsync(9999);
      expect(observation.settled).not.toHaveBeenCalled();
      expect(resolveHungRead).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(1);
      expectDocumentConfigTimeout(observation);
      await observation.waiting;
      expectDocumentConfigBudget(h);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      const expected = {from: 'en', videoTranslationEnabled: true};
      resolveHungRead!({success: true, value: encoding === 'string' ? JSON.stringify(expected) : expected});
      await vi.advanceTimersByTimeAsync(0);
      expectDocumentConfigTimeout(observation);
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }));
});


// Execute the actual helper module with controlled I/O ports. These tests do
// not launch a browser, query native processes, or replace its window logic.
describe('macOS 前台 native CDP helper 的启动与窗口契约（受控端口）', () => {
  type Viewport = {width: number; height: number};
  type Bounds = {left: number; top: number; width: number; height: number; windowState: string};
  type FixtureOptions = {
    platform?: string; headless?: boolean; background?: boolean; browserPath?: string;
    pendingOwnership?: boolean; appExists?: boolean; secondaryMissing?: boolean; omitBrowserPath?: boolean;
    openError?: Error; captureError?: Error; placementError?: Error; viewportError?: Error; readbackError?: Error;
    observedBounds?: Bounds; frontmostPid?: number; frontmostSequence?: Array<number | null>;
    delayedFrontmostRead?: number; delayedWindowRead?: number;
  };

  function controlledNativeHelper(options: FixtureOptions = {}) {
    const profileDir = '/controlled/fluentread-site-case-owned';
    const appBundle = '/Applications/Microsoft Edge.app';
    const ownedPid = 72191;
    const events: string[] = [];
    const nativeProcess = Object.assign(new EventEmitter(), {
      platform: options.platform ?? 'darwin', pid: 72190, env: {}, exit: vi.fn(),
    });
    const layout = {
      main: {x: 0, y: 0, width: 1920, height: 1080},
      screens: [
        {index: 0, isMain: true, frame: {x: 0, y: 0, width: 1920, height: 1080},
          visible: {x: 0, y: 0, width: 1920, height: 1040}},
        ...options.secondaryMissing ? [] : [{index: 1, isMain: false,
          frame: {x: 1920, y: 0, width: 1920, height: 1080},
          visible: {x: 1920, y: 0, width: 1920, height: 1040}}],
      ],
    };
    const tabs = {getCurrent: vi.fn(async () => ({id: 11})),
      query: vi.fn(async () => [{id: 12, url: 'https://news.ycombinator.com/'}]),
      update: vi.fn(async () => ({}))};
    const evaluateCallback = (callback: (...args: unknown[]) => unknown, arg?: unknown) =>
      new Script(`(${callback.toString()})(arg)`).runInNewContext({arg,
        window: {screen: {availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040},
          outerWidth: 1280, outerHeight: 900}, chrome: {tabs}}, {timeout: 1000});
    function fixturePage(initialUrl = 'about:blank') {
      let url = initialUrl;
      return {
        url: () => url, goto: vi.fn(async (destination: string) => {url = destination;}),
        keyboard: {press: vi.fn(async (_key: string) => undefined)},
        setViewportSize: vi.fn(async (_viewport: Viewport) => {
          events.push('viewport'); if (options.viewportError) throw options.viewportError;
        }),
        evaluate: vi.fn(async (callback: (...args: unknown[]) => unknown, arg?: unknown) => {
          events.push('page-evaluate'); return evaluateCallback(callback, arg);
        }),
      };
    }
    const pages: Array<ReturnType<typeof fixturePage>> = [];
    const worker = {url: () => 'chrome-extension://controlled/background.js', evaluate: vi.fn(async (callback: (...args: unknown[]) => unknown, arg?: unknown) =>
      evaluateCallback(callback, arg))};
    const pageSessions: Array<{send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>}> = [];
    const context = {
      pages: () => pages, browser: (): unknown => browser,
      newPage: vi.fn(async () => {events.push('new-page'); const page = fixturePage(); pages.push(page); return page;}),
      serviceWorkers: vi.fn(() => [worker]),
      newCDPSession: vi.fn(async (_page: unknown) => {
        const session = {send: vi.fn(async (method: string) => {
          if (method !== 'Target.getTargetInfo') throw new Error(`Unexpected page CDP ${method}`);
          return {targetInfo: {targetId: 'controlled-target'}};
        }), detach: vi.fn(async () => undefined)};
        pageSessions.push(session); return session;
      }),
      close: vi.fn(async () => undefined),
    };
    let requestedBounds: Bounds | undefined, windowRead = 0;
    let releaseWindowRead!: () => void, notifyWindowRead!: () => void;
    const delayedWindowRead = new Promise<void>(resolve => {releaseWindowRead = resolve;});
    const delayedWindowEntered = new Promise<void>(resolve => {notifyWindowRead = resolve;});
    const browserSessions: Array<{send: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>}> = [];
    const browser = {
      contexts: () => [context], close: vi.fn(async () => {events.push('native-connection-close');}),
      newBrowserCDPSession: vi.fn(async () => {
        const session = {send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          events.push(method);
          if (method === 'Browser.getWindowForTarget') return {windowId: 6};
          if (method === 'Browser.setWindowBounds') {
            if (options.placementError) throw options.placementError;
            requestedBounds = params!.bounds as Bounds; return {};
          }
          if (method === 'Browser.getWindowBounds') {
            const readIndex = windowRead++;
            if (readIndex === options.delayedWindowRead) {notifyWindowRead(); await delayedWindowRead;}
            if (options.readbackError) throw options.readbackError;
            return {bounds: options.observedBounds ?? requestedBounds};
          }
          if (method === 'Target.createTarget') {
            pages.push(fixturePage(params!.url as string)); return {targetId: 'controlled-background-target'};
          }
          if (method === 'Target.closeTarget') return {};
          throw new Error(`Unexpected browser CDP ${method}`);
        }), detach: vi.fn(async () => undefined)};
        browserSessions.push(session); return session;
      }),
    };
    const chromium = {
      connectOverCDP: vi.fn(async (_endpoint: string, _options: unknown) => {events.push('connect'); return browser;}),
      launchPersistentContext: vi.fn(async (_profile: string, _options: unknown) => {events.push('sdk-launch'); return context;}),
    };
    let resolveOwnership!: (pid: number) => void;
    const ownership = new Promise<number>(resolve => {resolveOwnership = resolve;});
    if (!options.pendingOwnership) resolveOwnership(ownedPid);
    const guardedClose = vi.fn(async (): Promise<unknown> => undefined);
    const guardBrowserClose = vi.fn((session: {close: () => Promise<unknown>;
      closeBrowserConnection: () => Promise<unknown>; useGuardedClose: (close: () => Promise<unknown>) => void}, profile: string) => {
      expect(profile).toBe(profileDir); events.push('guard');
      guardedClose.mockImplementation(async () => {
        events.push('guarded-close'); return session.closeBrowserConnection();
      });
      session.useGuardedClose(guardedClose); return session;
    });
    const getGuardedBrowserPid = vi.fn(async (_session: unknown) => {
      events.push('capture'); if (options.captureError) throw options.captureError;
      const pid = await ownership; events.push('capture-ready'); return pid;
    });
    const fsPort = {existsSync: vi.fn((path: string) => path === appBundle && options.appExists !== false),
      lstatSync: vi.fn(() => undefined), rmSync: vi.fn(),
      readFileSync: vi.fn((_path: string, _encoding: string) => '39221\n/devtools/browser/controlled')};
    let frontmostRead = 0;
    let releaseFocusCheck!: () => void;
    const delayedFocusCheck = new Promise<void>(resolve => {releaseFocusCheck = resolve;});
    const execFile = vi.fn(async (command: string, args: string[], _options?: unknown) => {
      if (command === '/usr/bin/open') {
        events.push('native-open'); if (options.openError) throw options.openError; return {stdout: ''};
      }
      if (command === '/usr/bin/osascript') {
        if (args[3].includes('frontmostApplication')) {
          events.push('frontmost-read');
          const readIndex = frontmostRead++;
          const value = options.frontmostSequence && readIndex < options.frontmostSequence.length
            ? options.frontmostSequence[readIndex] : options.frontmostPid ?? ownedPid;
          if (readIndex === options.delayedFrontmostRead) await delayedFocusCheck;
          return {stdout: JSON.stringify(value === null ? {} : {pid: value, name: 'controlled application'})};
        }
        if (args[3].includes('NSScreen.screens')) return {stdout: JSON.stringify(layout)};
      }
      throw new Error(`Unexpected native I/O port ${command}`);
    });
    const module = {exports: {}};
    const helperSource = readFileSync(BUNDLED_FOCUS_SAFE_HELPER, 'utf8');
    new Script(`${helperSource}\nmodule.exports.__testBackgroundState = context => backgroundContexts.get(context);`,
      {filename: BUNDLED_FOCUS_SAFE_HELPER}).runInNewContext({module,
      exports: module.exports, process: nativeProcess, console, setTimeout, clearTimeout,
      require: (id: string) => {
        if (id === 'node:fs') return fsPort;
        if (id === 'node:path') return require(id);
        if (id === 'node:crypto') return {randomUUID: () => 'controlled-background-marker'};
        if (id === 'node:child_process') return {execFile};
        if (id === 'node:util') return {promisify: (fn: unknown) => fn};
        if (id === './owned-browser-close.cjs') return {guardBrowserClose, getGuardedBrowserPid};
        throw new Error(`Unexpected helper module port ${id}`);
      }}, {timeout: 1000});
    const helper = module.exports as {
      launchFocusSafePersistentContext(options: unknown): Promise<{context: typeof context; launchMode: string;
        focusPolicy: string; windowPlacement: Record<string, unknown>; close: () => Promise<unknown>}>;
      newPageWithoutForeground(browserContext: typeof context): Promise<ReturnType<typeof fixturePage>>;
      __testBackgroundState(browserContext: typeof context): {focusViolation?: Error};
      activateExtensionTabWithoutForeground(browserContext: typeof context, page: ReturnType<typeof fixturePage>): Promise<void>;
    };
    const launchOptions = {chromium, profileDir,
      ...options.omitBrowserPath ? {} : {browserPath: options.browserPath ?? `${appBundle}/Contents/MacOS/Microsoft Edge`},
      headless: options.headless ?? false, background: options.background ?? false,
      browserArgs: ['--load-extension=/controlled/extension'], viewport: {width: 1280, height: 900}, timeout: 30000};
    const launch = () => helper.launchFocusSafePersistentContext(launchOptions);
    return {helper, launch, launchOptions, profileDir, ownedPid, events, chromium, context, browser, pages,
      tabs, worker, pageSessions, browserSessions, execFile, fsPort, guardBrowserClose, guardedClose,
      getGuardedBrowserPid, resolveOwnership, releaseFocusCheck, releaseWindowRead, delayedWindowEntered, nativeProcess};
  }

  async function drainNativeHelper() {for (let index = 0; index < 8; index++) await Promise.resolve();}
  function expectNoProfileRemoval(f: ReturnType<typeof controlledNativeHelper>) {
    expect(f.fsPort.rmSync.mock.calls.every(([path]) => path !== f.profileDir)).toBe(true);
  }

  it('前台.app等待精确owner后才创建页和居中，原生open允许前台且实际读回第二屏窗口', async () => {
    const f = controlledNativeHelper({pendingOwnership: true,
      observedBounds: {left: 2244, top: 114, width: 1280, height: 900, windowState: 'normal'}});
    const opening = f.launch(); await drainNativeHelper();
    expect(f.guardBrowserClose).toHaveBeenCalledOnce(); expect(f.getGuardedBrowserPid).toHaveBeenCalledOnce();
    expect(f.context.newPage).not.toHaveBeenCalled(); expect(f.browser.newBrowserCDPSession).not.toHaveBeenCalled();
    f.resolveOwnership(f.ownedPid); const session = await opening;
    try {
      expect(session.context).toBe(f.context);
      expect(session).toMatchObject({launchMode: 'macos-foreground-cdp', focusPolicy: 'foreground-authorized',
        windowPlacement: {mode: 'headed-centered', visible: true, hidden: false, centered: true,
          displayTarget: 'secondary', source: 'macos-nsscreen', screenIndex: 1,
          bounds: {left: 2244, top: 114, width: 1280, height: 900}}});
      expect(f.execFile.mock.calls.find(([command]) => command === '/usr/bin/open')?.[1])
        .toEqual(['-n', '-a', '/Applications/Microsoft Edge.app', '--args',
          '--user-data-dir=' + f.profileDir, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
          '--enable-automation', '--password-store=basic', '--use-mock-keychain', '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-startup-window',
          '--window-size=1280,900', '--load-extension=/controlled/extension']);
      expect(f.chromium.launchPersistentContext).not.toHaveBeenCalled();
      expect(f.events).not.toContain('frontmost-read'); // Background policy must not override authorized foreground.
      expect(f.events.indexOf('capture-ready')).toBeLessThan(f.events.indexOf('new-page'));
      expect(f.browserSessions[0].send.mock.calls.map(([method]) => method))
        .toEqual(['Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Browser.getWindowBounds']);
      expect(f.browserSessions[0].send).toHaveBeenCalledWith('Browser.setWindowBounds', {windowId: 6,
        bounds: {left: 2240, top: 110, width: 1280, height: 900, windowState: 'normal'}});
      expectNoProfileRemoval(f);
    } finally {await session.close();}
    expect(f.guardedClose).toHaveBeenCalledOnce(); expect(f.browser.close).toHaveBeenCalledOnce();
    expect(f.nativeProcess.listenerCount('SIGINT')).toBe(0); expect(f.nativeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('后续正文页与popup页仍用原context API，逐页设固定viewport并保留键盘及扩展tab端口', async () => {
    const f = controlledNativeHelper(); const session = await f.launch();
    try {
      f.launchOptions.viewport.width = 777; // The owned foreground context stores its own viewport snapshot.
      const content = await f.helper.newPageWithoutForeground(f.context);
      const popup = await f.helper.newPageWithoutForeground(f.context);
      await content.goto('https://news.ycombinator.com/');
      await content.keyboard.press('Control+KeyQ');
      await popup.goto('chrome-extension://controlled/popup.html');
      await f.helper.activateExtensionTabWithoutForeground(f.context, popup);
      await f.helper.activateExtensionTabWithoutForeground(f.context, content);
      expect(f.pages).toHaveLength(3);
      for (const page of f.pages) {
        expect(page.setViewportSize).toHaveBeenCalledOnce();
        expect(page.setViewportSize).toHaveBeenCalledWith({width: 1280, height: 900});
      }
      expect(f.context.serviceWorkers).toHaveBeenCalledOnce(); expect(f.worker.evaluate).toHaveBeenCalledOnce();
      expect(f.tabs.update.mock.calls).toEqual([[11, {active: true}], [12, {active: true}]]);
      expect(content.keyboard.press).toHaveBeenCalledOnce();
      expect(content.keyboard.press).toHaveBeenCalledWith('Control+KeyQ');
      expect(f.chromium.launchPersistentContext).not.toHaveBeenCalled();
    } finally {await session.close();}
  });

  it.each(['open', 'capture', 'viewport', 'placement', 'readback'] as const)('%s失败保留原错误和profile，.app不能fallback SDK', async (stage) => {
    const error = new Error('CONTROLLED_NATIVE_' + stage);
    const f = controlledNativeHelper({[stage + 'Error']: error});
    await expect(f.launch()).rejects.toBe(error);
    expect(f.chromium.launchPersistentContext).not.toHaveBeenCalled(); expectNoProfileRemoval(f);
    if (stage === 'open') {
      expect(f.chromium.connectOverCDP).not.toHaveBeenCalled(); expect(f.guardedClose).not.toHaveBeenCalled();
    } else {
      expect(f.guardedClose).toHaveBeenCalledOnce(); expect(f.browser.close).toHaveBeenCalledOnce();
      if (stage === 'capture') expect(f.context.newPage).not.toHaveBeenCalled();
    }
  });

  it.each([
    {left: 20, top: 100, width: 1280, height: 900, windowState: 'normal'},
    {left: 2240, top: 110, width: 1280, height: 900, windowState: 'minimized'},
  ])('native窗口实际读回%s不满足第二屏契约时关闭并保留profile', async observedBounds => {
    const f = controlledNativeHelper({observedBounds});
    await expect(f.launch()).rejects.toThrow();
    expect(f.browserSessions[0].send).toHaveBeenCalledWith('Browser.getWindowBounds', {windowId: 6});
    expect(f.guardedClose).toHaveBeenCalledOnce(); expect(f.browser.close).toHaveBeenCalledOnce();
    for (const session of [...f.pageSessions, ...f.browserSessions]) expect(session.detach).toHaveBeenCalledOnce();
    expectNoProfileRemoval(f);
  });

  it('secondary没有真实第二屏时不能退到主屏后写成功metadata', async () => {
    const f = controlledNativeHelper({secondaryMissing: true});
    await expect(f.launch()).rejects.toThrow();
    expect(f.guardedClose).toHaveBeenCalledOnce(); expect(f.browser.close).toHaveBeenCalledOnce();
    expectNoProfileRemoval(f);
  });

  it('后台新页复用已定位的正常窗口，每次仍读回几何和前台应用', async () => {
    const f = controlledNativeHelper({background: true, frontmostPid: 99001});
    const session = await f.launch();
    await f.helper.newPageWithoutForeground(f.context);
    await f.helper.newPageWithoutForeground(f.context);
    const calls = f.browserSessions.flatMap(item => item.send.mock.calls);
    expect(calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(3);
    expect(f.browserSessions[0].send).toHaveBeenCalledWith('Target.createTarget', {
      url: 'about:blank#fluentread-background-controlled-background-marker', background: true});
    expect(calls.filter(([method]) => method === 'Browser.setWindowBounds')).toHaveLength(1);
    expect(calls.filter(([method]) => method === 'Browser.getWindowBounds').length).toBeGreaterThanOrEqual(3);
    expect(f.events.filter(event => event === 'frontmost-read')).toHaveLength(13);
    expect(session.windowPlacement.browserFrontmost).toBe(false);
    expect((session.windowPlacement.focusSafety as {samples: Array<{stage: string}>}).samples.map(sample => sample.stage))
      .toEqual(['before-target', 'after-target', 'after-placement', 'before-return']);
    await session.close();
  });

  it('原background仍带-g及Target.background并拒绝自有Edge成为前台', async () => {
    const f = controlledNativeHelper({background: true});
    await expect(f.launch()).rejects.toThrow(/成为.*前台/u);
    expect(f.execFile.mock.calls.find(([command]) => command === '/usr/bin/open')?.[1]?.[0]).toBe('-g');
    expect(f.browserSessions[0].send).not.toHaveBeenCalledWith('Target.createTarget', expect.anything());
    expect(f.context.newPage).not.toHaveBeenCalled(); expect(f.guardedClose).toHaveBeenCalledOnce();
    expectNoProfileRemoval(f);
  });

  it.each([
    {stage: 'before-target', sequence: [99001, 72191], creates: false, positions: false},
    {stage: 'after-target', sequence: [99001, 99001, 72191], creates: true, positions: false},
    {stage: 'after-placement', sequence: [99001, 99001, 99001, 72191], creates: true, positions: true},
    {stage: 'before-return', sequence: [99001, 99001, 99001, 99001, 72191], creates: true, positions: true},
  ])('后台页签在 $stage 检测到隔离浏览器前台时停止并保存该次证据', async ({stage, sequence, creates, positions}) => {
    const f = controlledNativeHelper({background: true, frontmostSequence: sequence});
    const error = await f.launch().then(() => null, caught => caught as Error & {code?: string; focusSafety?: {
      browserPid: number; targetId: string | null; samples: Array<{stage: string; application: {pid: number} | null}>;
    }});
    expect(error).toMatchObject({code: 'FOCUS_SAFETY_VIOLATION', focusSafety: {browserPid: f.ownedPid}});
    expect(error!.focusSafety!.samples.at(-1)).toMatchObject({stage, application: {pid: f.ownedPid}});
    expect(error!.message).toContain('前台检查记录');
    expect(error!.focusSafety!.targetId).toBe(creates ? 'controlled-background-target' : null);
    const calls = f.browserSessions.flatMap(session => session.send.mock.calls.map(([method]) => method));
    expect(calls.includes('Target.createTarget')).toBe(creates);
    expect(calls.includes('Browser.getWindowForTarget')).toBe(positions);
    expect(calls.includes('Target.closeTarget')).toBe(creates);
    expect(f.context.newPage).not.toHaveBeenCalled(); expect(f.guardedClose).toHaveBeenCalledOnce();
    for (const session of f.browserSessions) expect(session.detach).toHaveBeenCalledOnce();
    expectNoProfileRemoval(f);
  });

  it('无法读取前台应用时保留未知状态并停止，不创建页签', async () => {
    const f = controlledNativeHelper({background: true, frontmostSequence: [99001, null]});
    const error = await f.launch().then(() => null, caught => caught as Error & {focusSafety?: {
      samples: Array<{stage: string; application: unknown}>;
    }});
    expect(error!.message).toContain('无法读取 macOS 前台应用');
    expect(error!.focusSafety!.samples.at(-1)).toMatchObject({stage: 'before-target', application: null});
    expect(f.browserSessions[0].send).not.toHaveBeenCalledWith('Target.createTarget', expect.anything());
    expectNoProfileRemoval(f);
  });

  it('后续建页失败时清除上一页成功的前台快照并保留本次失败阶段', async () => {
    const f = controlledNativeHelper({background: true,
      frontmostSequence: [99001, 99001, 99001, 99001, 99001, 99001, 72191]});
    const session = await f.launch();
    try {
      const previous = session.windowPlacement.focusSafety;
      expect(session.windowPlacement.browserFrontmost).toBe(false);
      const error = await f.helper.newPageWithoutForeground(f.context).then(() => null, caught => caught as Error & {
        focusSafety?: {samples: Array<{stage: string; application: {pid: number} | null}>};
      });
      expect(error).toBeTruthy();
      expect(session.windowPlacement.browserFrontmost).toBe(true);
      expect(session.windowPlacement.frontmostAfter).toMatchObject({pid: f.ownedPid});
      expect(session.windowPlacement.focusSafety).not.toBe(previous);
      expect(error!.focusSafety!.samples.map(sample => sample.stage)).toEqual(['before-target', 'after-target']);
      expect(error!.focusSafety!.samples.at(-1)?.application?.pid).toBe(f.ownedPid);
      expect(f.browserSessions.at(-1)!.send).toHaveBeenCalledWith('Target.closeTarget', {targetId: 'controlled-background-target'});
      const sessionsBefore = f.browserSessions.length;
      await expect(f.helper.newPageWithoutForeground(f.context)).rejects.toBe(error);
      expect(f.browserSessions).toHaveLength(sessionsBefore);
    } finally {await session.close();}
  });

  it('窗口定位错误不得把先前阶段的非前台快照标为建页成功', async () => {
    const options: FixtureOptions = {background: true, frontmostPid: 99001};
    const f = controlledNativeHelper(options);
    const session = await f.launch();
    try {
      const original = new Error('window readback failed');
      options.readbackError = original;
      const error = await f.helper.newPageWithoutForeground(f.context).then(() => null, caught => caught as Error & {
        focusSafety?: {outcome: string; samples: Array<{stage: string}>};
      });
      expect(error).toBe(original);
      expect(error!.focusSafety).toMatchObject({outcome: 'incomplete'});
      expect(error!.focusSafety!.samples.map(sample => sample.stage)).toEqual(['before-target', 'after-target']);
      expect(session.windowPlacement.browserFrontmost).toBeNull();
      expect(session.windowPlacement.frontmostAfter).toBeNull();
      expect(f.browserSessions.at(-1)!.send).toHaveBeenCalledWith('Target.closeTarget', {targetId: 'controlled-background-target'});
    } finally {await session.close();}
  });

  it('并发建页中一次检测失败后，较早开始但迟到的安全读数也不能继续建页', async () => {
    const f = controlledNativeHelper({background: true, delayedFrontmostRead: 6,
      frontmostSequence: [99001, 99001, 99001, 99001, 99001, 99001, 99001, 72191]});
    const session = await f.launch();
    try {
      const first = f.helper.newPageWithoutForeground(f.context).then(() => null, error => error);
      const second = f.helper.newPageWithoutForeground(f.context).then(() => null, error => error);
      const failure = await first;
      expect(failure).toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
      f.releaseFocusCheck();
      expect(await second).toBe(failure);
      const methods = f.browserSessions.flatMap(item => item.send.mock.calls.map(([method]) => method));
      // 含 launch 时的一次，以及并发两次中唯一在故障前创建的一次。
      expect(methods.filter(method => method === 'Target.createTarget')).toHaveLength(2);
      expect(methods.filter(method => method === 'Target.closeTarget')).toHaveLength(1);
      expect(session.windowPlacement.browserFrontmost).toBe(true);
    } finally {f.releaseFocusCheck(); await session.close();}
  });

  it('并发页签已进入窗口定位时，另一页检测前台后不得继续设置窗口', async () => {
    const options: FixtureOptions = {background: true, delayedWindowRead: 2,
      frontmostSequence: [99001, 99001, 99001, 99001, 99001, 99001, 99001, 99001, 72191]};
    const f = controlledNativeHelper(options);
    const session = await f.launch();
    try {
      // 假设此窗口需要重新定位；让第一条建页在定位读回时挂起。
      options.observedBounds = {left: 0, top: 0, width: 1280, height: 900, windowState: 'normal'};
      const first = f.helper.newPageWithoutForeground(f.context).then(() => null, error => error);
      await f.delayedWindowEntered;
      const failure = await f.helper.newPageWithoutForeground(f.context).then(() => null, error => error);
      expect(failure).toMatchObject({code: 'FOCUS_SAFETY_VIOLATION'});
      f.releaseWindowRead();
      expect(await first).toBe(failure);
      const methods = f.browserSessions.flatMap(item => item.send.mock.calls.map(([method]) => method));
      // launch 设置一次；第一条建页在被打断后不得再写窗口。
      expect(methods.filter(method => method === 'Browser.setWindowBounds')).toHaveLength(1);
      expect(methods.filter(method => method === 'Target.closeTarget')).toHaveLength(2);
      expect(session.windowPlacement.browserFrontmost).toBe(true);
    } finally {f.releaseWindowRead(); await session.close();}
  });

  it.each(['before-target', 'before-return'])('共享故障在 %s 检查返回后的微任务间隙发生时立即停止', async phase => {
    const f = controlledNativeHelper({background: true, frontmostPid: 99001});
    const session = await f.launch();
    const state = f.helper.__testBackgroundState(f.context);
    const failure = Object.assign(new Error('concurrent focus violation'), {code: 'FOCUS_SAFETY_VIOLATION'});
    let last = session.windowPlacement.frontmostAfter, injected = false;
    Object.defineProperty(session.windowPlacement, 'frontmostAfter', {
      configurable: true,
      get: () => last,
      set: value => {
        last = value;
        const evidence = session.windowPlacement.focusSafety as {samples: Array<{stage: string}>};
        if (!injected && evidence?.samples.at(-1)?.stage === phase) {
          injected = true;
          // 模拟另一条建页在检查完成、调用方恢复前锁存前台故障。
          queueMicrotask(() => {state.focusViolation = failure; session.windowPlacement.browserFrontmost = true;});
        }
      },
    });
    try {
      expect(await f.helper.newPageWithoutForeground(f.context).then(() => null, error => error)).toBe(failure);
      expect(injected).toBe(true);
      const methods = f.browserSessions.flatMap(item => item.send.mock.calls.map(([method]) => method));
      expect(methods.filter(method => method === 'Target.createTarget')).toHaveLength(phase === 'before-target' ? 1 : 2);
      expect(methods.filter(method => method === 'Target.closeTarget')).toHaveLength(phase === 'before-target' ? 0 : 1);
    } finally {await session.close();}
  });

  it('浏览器 CDP 会话创建失败时标记本次建页未完成并清除旧快照', async () => {
    const f = controlledNativeHelper({background: true, frontmostPid: 99001});
    const session = await f.launch();
    const failure = new Error('controlled session creation failure');
    f.browser.newBrowserCDPSession.mockRejectedValueOnce(failure);
    try {
      const error = await f.helper.newPageWithoutForeground(f.context).then(() => null, caught => caught);
      expect(error).toBe(failure);
      expect(error.focusSafety).toMatchObject({outcome: 'incomplete', targetId: null, samples: []});
      expect(session.windowPlacement.browserFrontmost).toBeNull();
      expect(session.windowPlacement.frontmostAfter).toBeNull();
    } finally {await session.close();}
  });

  it.each([
    {platform: 'darwin', headless: true, launchMode: 'playwright-headless'},
    {platform: 'darwin', headless: false, omitBrowserPath: true, launchMode: 'playwright-headed'},
    {platform: 'linux', headless: false, launchMode: 'playwright-headed'},
    {platform: 'darwin', headless: false, browserPath: '/controlled/non-app-edge', launchMode: 'playwright-headed'},
  ])('原SDK路径保持：%j', async options => {
    const f = controlledNativeHelper(options); const session = await f.launch();
    try {
      expect(session.launchMode).toBe(options.launchMode);
      expect(f.chromium.launchPersistentContext).toHaveBeenCalledOnce();
      expect(f.chromium.launchPersistentContext).toHaveBeenCalledWith(f.profileDir, {
        executablePath: f.launchOptions.browserPath, headless: options.headless,
        args: f.launchOptions.browserArgs, viewport: f.launchOptions.viewport});
      expect(f.chromium.connectOverCDP).not.toHaveBeenCalled(); expect(f.guardBrowserClose).not.toHaveBeenCalled();
      expect(f.execFile.mock.calls.some(([command]) => command === '/usr/bin/open')).toBe(false);
      const page = await f.helper.newPageWithoutForeground(f.context);
      expect(page.setViewportSize).not.toHaveBeenCalled(); // SDK launch already owns the viewport contract.
    } finally {await session.close();}
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it('可解析但不存在的.app拒绝启动，不落到SDK；非Mac后台拒绝仍在launch前', async () => {
    for (const options of [{appExists: false}, {platform: 'linux', background: true}]) {
      const f = controlledNativeHelper(options); await expect(f.launch()).rejects.toThrow();
      expect(f.chromium.launchPersistentContext).not.toHaveBeenCalled(); expect(f.chromium.connectOverCDP).not.toHaveBeenCalled();
      expect(f.execFile).not.toHaveBeenCalled(); expectNoProfileRemoval(f);
    }
  });
});


describe('划词生命周期 CLI 诊断前置', () => {
    it('需要诊断的专项均在启动资源前拒绝缺失采集器，其余模式保留原有参数校验', () => {
        const script = resolve(PROJECT_ROOT, 'scripts/run-selection-trigger-test.cjs');
        for (const mode of ['--lifecycle-only', '--document-shell-only', '--click-selection-only', '--click-selection-stress-only']) {
            const result = spawnSync(process.execPath, [script, mode], {encoding: 'utf8'});
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('划词专项需要 --runtime-diagnostics');
        }
        for (const mode of ['--direction-only', '--context-menu-only']) {
            const result = spawnSync(process.execPath, [script, mode], {encoding: 'utf8'});
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('必须传入 --playwright-root');
            expect(result.stderr).not.toContain('划词专项需要 --runtime-diagnostics');
        }
    });
});
