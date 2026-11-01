import {afterAll, describe, expect, it} from 'vitest';
import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Execute the original public tooling with controlled browser/package ports.
// These cases prove CLI resource ownership, not extension/browser interaction.
const sourceRoot = resolve(process.env.FLUENTREAD_AUDIT49J_SOURCE_ROOT || '.');
const workspaceRoot = resolve('.');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'fluentread-audit49j-'));
const evidenceRoot = process.env.FLUENTREAD_AUDIT49J_EVIDENCE;
let serial = 0;

type ScanOwner = {child: ChildProcess; closed: Promise<{code: number | null; signal: NodeJS.Signals | null}>; profile: string; output: string; stop?: Promise<void>};
const scanOwners = new Map<string, ScanOwner[]>();
const scanProcessReceipts: Record<string, unknown>[] = [];

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('controlled owned-process deadline')), milliseconds);})]);}
    finally {if (timer) clearTimeout(timer);}
}

function ownerGone(owner: ScanOwner) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null) return true;
    if (!owner.child.pid) return true;
    try {process.kill(owner.child.pid, 0); return false;}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error;}
}

async function stopScanOwner(owner: ScanOwner, reason: string) {
    if (owner.stop) return owner.stop;
    owner.stop = (async () => {
        const signals: string[] = [];
        if (!ownerGone(owner)) {signals.push('SIGTERM'); owner.child.kill('SIGTERM');}
        let exit;
        try {exit = await bounded(owner.closed, 5000);}
        catch {if (!ownerGone(owner)) {signals.push('SIGKILL'); owner.child.kill('SIGKILL');} exit = await bounded(owner.closed, 1500);}
        const gone = ownerGone(owner);
        scanProcessReceipts.push({reason, pid: owner.child.pid, profile: owner.profile, signals, waited: true, gone,
            timerCleared: owner.output.includes('"timerCleared":true'), fdClosed: owner.output.includes('"fdClosed":true'),
            profileExists: existsSync(owner.profile), ...exit});
        if (!gone) throw new Error('controlled owned-process still alive after close');
    })();
    return owner.stop;
}

async function cleanupScanOwners(root: string, reason: string) {
    for (const owner of scanOwners.get(root) || []) await stopScanOwner(owner, reason);
    scanOwners.delete(root);
}

afterAll(async () => {
    for (const root of [...scanOwners.keys()]) await cleanupScanOwners(root, 'suite-finally');
    if (evidenceRoot) {
        mkdirSync(evidenceRoot, {recursive: true});
        writeFileSync(join(evidenceRoot, 'scan-owned-process-receipts.json'), JSON.stringify({receipts: scanProcessReceipts, remainingOwnerRoots: scanOwners.size}, null, 2));
    }
    rmSync(fixtureRoot, {recursive: true, force: true});
});

async function child(args: string[], env: NodeJS.ProcessEnv, cwd = sourceRoot) {
    const started = Date.now();
    return await new Promise<{code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean}>((resolveResult, reject) => {
        const scanRoot = env.AUDIT_SCAN_ROOT;
        const task = spawn(process.execPath, args, {cwd, env: {...process.env, ...env}, detached: process.platform !== 'win32', stdio: scanRoot ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']});
        // Only this parent creates/stops actors; PID text is never authority to
        // signal a process. The public CLI owns only the injected launcher port.
        const onMessage = async (message: any) => {
            try {
                if (!scanRoot || message?.type !== 'audit-owner-start' && message?.type !== 'audit-owner-stop') throw new Error('unexpected controlled actor request');
                const profile = resolve(message.profileDir);
                if (!profile.startsWith(resolve(join(scanRoot, 'profiles')) + '/')) throw new Error('refuse foreign actor profile');
                const owners = scanOwners.get(scanRoot) || [];
                if (message.type === 'audit-owner-start') {
                    if (owners.some(owner => owner.profile === profile)) throw new Error('refuse duplicate actor');
                    const actorScript = join(scanRoot, 'owner.cjs');
                    // A real FD makes rejected-close profiles nonempty. Only
                    // this test parent creates the actor and holds its handle.
                    writeFileSync(actorScript, String.raw`
const fs=require('node:fs'),path=require('node:path');
const profile=process.argv[2],profileArguments=process.argv.filter(argument=>argument.startsWith('--user-data-dir='));
if(profileArguments.length!==1||profileArguments[0]!=='--user-data-dir='+profile)throw Error('controlled actor exact profile argument missing');
const fd=fs.openSync(path.join(profile,'fixture-owner.lock'),'w');
const timer=setInterval(()=>{},1000);
const emptyOnExit=process.argv.includes('--remove-owned-lock-on-exit');
const emptyWhileLive=process.argv.includes('--unlink-owned-lock-after-open');
// A held FD and referenced timer survive unlinking their only profile entry.
if(emptyWhileLive)fs.unlinkSync(path.join(profile,'fixture-owner.lock'));
let finished=false;
function finish(code){
 if(finished)return;finished=true;clearInterval(timer);clearTimeout(deadline);fs.closeSync(fd);
 const receipt={timerCleared:true,fdClosed:true};
 if(emptyOnExit){
  try {fs.fstatSync(fd);throw Error('controlled actor FD remained open');}
  catch(error){if(error.code!=='EBADF')throw error;receipt.fdCloseCode=error.code;}
  fs.unlinkSync(path.join(profile,'fixture-owner.lock'));
  receipt.lockRemoved=!fs.existsSync(path.join(profile,'fixture-owner.lock'));
 }
 if(emptyWhileLive){
  try {fs.fstatSync(fd);throw Error('controlled live-empty actor FD remained open');}
  catch(error){if(error.code!=='EBADF')throw error;receipt.fdCloseCode=error.code;}
  receipt.lockRemoved=!fs.existsSync(path.join(profile,'fixture-owner.lock'));
 }
 process.stdout.write(JSON.stringify(receipt)+'\n',()=>process.exit(code));
}
process.once('SIGTERM',()=>finish(0));
const deadline=setTimeout(()=>finish(2),60000);
process.stdout.write(JSON.stringify({ready:true,pid:process.pid,argv:process.argv,...(emptyOnExit||emptyWhileLive?{fdOpen:fs.fstatSync(fd).isFile(),timerReferenced:timer.hasRef(),...(emptyWhileLive?{lockRemoved:!fs.existsSync(path.join(profile,'fixture-owner.lock'))}:{})}: {})})+'\n');
`);
                    const actorArgs = [actorScript, profile, `--user-data-dir=${profile}`];
                    if (env.AUDIT_PORT_MODE === 'scan-capture-query-empty') actorArgs.push('--remove-owned-lock-on-exit');
                    if (env.AUDIT_PORT_MODE === 'scan-partial-empty') actorArgs.push('--unlink-owned-lock-after-open');
                    const actor = spawn(process.execPath, actorArgs, {stdio: ['ignore', 'pipe', 'pipe']});
                    const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolveExit => actor.once('close', (code, signal) => resolveExit({code, signal})));
                    const owner: ScanOwner = {child: actor, closed, profile, output: ''};
                    owners.push(owner); scanOwners.set(scanRoot, owners);
                    const ready = new Promise<void>((resolveReady, rejectReady) => {
                        actor.once('error', rejectReady);
                        actor.stdout!.on('data', data => {owner.output += String(data); if (owner.output.includes('"ready":true')) resolveReady();});
                        actor.stderr!.on('data', data => {owner.output += String(data);});
                    });
                    await bounded(ready, 1500);
                    // Native ps runs in the test parent, outside CLI preload
                    // ports. Record the real start/command row, never synthesize it.
                    const psRow = await bounded(new Promise<string>((resolveSnapshot, rejectSnapshot) => {
                        execFile('/bin/ps', ['-ww', '-p', String(actor.pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='],
                            {encoding: 'utf8', timeout: 750, maxBuffer: 1024 * 1024, env: {...process.env, LC_ALL: 'C'}},
                            (error, stdout) => error ? rejectSnapshot(error) : resolveSnapshot(stdout));
                    }), 1500);
                    const observed = psRow.trim().match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S[^\r\n]*)$/);
                    const profileArguments = observed?.[3].split(/\s+/).filter(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
                    if (!observed || Number(observed[1]) !== actor.pid || profileArguments?.length !== 1 || profileArguments[0] !== `--user-data-dir=${profile}`)
                        throw new Error('controlled actor native ps ownership unconfirmed');
                    const startIdentity = observed[2].replace(/\s+/g, ' ');
                    scanProcessReceipts.push({reason: 'actual-parent-owned-start', pid: actor.pid, profile, ready: true, actorArgs, psNative: true, psRow, startIdentity,
                        ...(env.AUDIT_PORT_MODE === 'scan-capture-query-empty' || env.AUDIT_PORT_MODE === 'scan-partial-empty' ? {actorReady: JSON.parse(owner.output.split('\n').find(line => line.includes('"ready":true'))!), profileEntries: readdirSync(profile)} : {})});
                    if (task.connected) task.send({type: message.type + '-receipt', pid: actor.pid, actualOwnedHandle: true, profileArgument: `--user-data-dir=${profile}`, psNative: true});
                } else {
                    const owner = owners.find(owner => owner.profile === profile);
                    if (!owner) throw new Error('refuse unowned actor stop');
                    await stopScanOwner(owner, 'awaited-launcher-close');
                    if (env.AUDIT_PORT_MODE === 'scan-capture-query-empty') {
                        // Observe absence through native ps after this held handle's
                        // close event; neither preload ports nor PID text can fake it.
                        const absent = await bounded(new Promise<{code: number; stdout: string; stderr: string}>((resolveSnapshot, rejectSnapshot) => {
                            execFile('/bin/ps', ['-ww', '-p', String(owner.child.pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='],
                                {encoding: 'utf8', timeout: 750, maxBuffer: 1024 * 1024, env: {...process.env, LC_ALL: 'C'}},
                                (error, stdout, stderr) => {
                                    if (error && error.code !== 1) rejectSnapshot(error);
                                    else resolveSnapshot({code: error ? 1 : 0, stdout, stderr});
                                });
                        }), 1500);
                        if (absent.code !== 1 || absent.stdout !== '' || absent.stderr !== '') throw new Error('controlled actor native ps absence unconfirmed');
                        const actorExit = JSON.parse(owner.output.split('\n').find(line => line.includes('"timerCleared":true'))!);
                        const profileEntries = readdirSync(profile);
                        if (!actorExit.lockRemoved || actorExit.fdCloseCode !== 'EBADF' || profileEntries.length) throw new Error('controlled actor empty profile unconfirmed');
                        scanProcessReceipts.push({reason: 'empty-profile-launcher-close-confirmed', pid: owner.child.pid, profile, psNative: true, absent,
                            actorExit, profileEntries, code: owner.child.exitCode, signal: owner.child.signalCode});
                    }
                    if (task.connected) task.send({type: message.type + '-receipt', pid: owner.child.pid, waited: true, gone: ownerGone(owner), timerCleared: owner.output.includes('"timerCleared":true'), fdClosed: owner.output.includes('"fdClosed":true'),
                        ...(env.AUDIT_PORT_MODE === 'scan-capture-query-empty' ? {psAbsent: true, lockRemoved: true} : {})});
                }
            } catch (error) {if (task.connected) task.send({type: message?.type + '-receipt', error: String(error)});}
        };
        if (scanRoot) task.on('message', onMessage);
        let stdout = '', stderr = '', timedOut = false, cancelled = false;
        const signal = (value: NodeJS.Signals) => {
            if (!task.pid) return;
            try {process.kill(process.platform === 'win32' ? task.pid : -task.pid, value);} catch { /* Already exited. */ }
        };
        let force: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            signal('SIGTERM');
            force = setTimeout(() => signal('SIGKILL'), 5000);
        }, 8000);
        task.stdout!.on('data', data => {stdout += String(data); if (env.AUDIT_CANCEL_ON_MARKER && !cancelled && stdout.includes(env.AUDIT_CANCEL_ON_MARKER)) {cancelled = true; signal('SIGTERM');}});
        task.stderr!.on('data', data => {stderr += String(data);});
        task.once('error', error => {clearTimeout(timer); if (force) clearTimeout(force); reject(error);});
        task.once('close', (code, exitSignal) => {
            task.off('message', onMessage);
            clearTimeout(timer); if (force) clearTimeout(force);
            const result = {code, signal: exitSignal, stdout, stderr, timedOut};
            if (evidenceRoot) {
                mkdirSync(evidenceRoot, {recursive: true});
                writeFileSync(join(evidenceRoot, `child-${++serial}.json`), JSON.stringify({args, cwd, elapsedMs: Date.now() - started, ...result}, null, 2));
            }
            resolveResult(result);
        });
    });
}

async function browserFailure(script: string, mode: 'launch' | 'partial-launch' | 'ready' | 'close' | 'profile') {
    const root = mkdtempSync(join(fixtureRoot, 'browser-'));
    const temp = join(root, 'profiles'); mkdirSync(temp);
    const foreign = join(root, 'foreign-profile'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'foreign fixture must survive');
    const extension = join(root, 'chrome-mv3'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}));
    const helper = join(root, 'focus-safe.cjs');
    const packages = join(root, 'packages'); mkdirSync(join(packages, 'playwright'), {recursive: true});
    writeFileSync(join(packages, 'playwright/index.js'), 'module.exports = {chromium: {}};');
    mkdirSync(join(packages, 'node_modules/playwright'), {recursive: true});
    writeFileSync(join(packages, 'node_modules/playwright/index.js'), 'module.exports = {chromium: {}};');
    writeFileSync(helper, String.raw`
process.channel?.unref();
function actorPort(type,profileDir){return new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>{process.off('message',message);process.channel?.unref();reject(Error('controlled actor port timeout'));},6500);
 function message(receipt){if(receipt?.type!==type+'-receipt')return;clearTimeout(timeout);process.off('message',message);process.channel?.unref();if(receipt.error)reject(Error(receipt.error));else resolve(receipt);}
 process.on('message',message);process.channel?.ref();process.send({type,profileDir});
});}
exports.launchFocusSafePersistentContext = async options => {
    console.log('PUBLIC_LAUNCH_REACHED', options.profileDir);
    if (process.env.AUDIT_BROWSER_FAILURE === 'partial-launch') {
        require('node:fs').writeFileSync(require('node:path').join(options.profileDir, 'uncertain-owner'), 'owned initialization sentinel');
        throw new Error('controlled launch failure');
    }
    if (process.env.AUDIT_BROWSER_FAILURE === 'launch') throw new Error('controlled launch failure');
    const receipt=await actorPort('audit-owner-start',options.profileDir);
    if(!receipt.actualOwnedHandle||!Number.isSafeInteger(receipt.pid)||receipt.pid<=0||!receipt.psNative||receipt.profileArgument!=='--user-data-dir='+options.profileDir)throw Error('controlled actor ownership missing');
    console.log('OWNED_NODE_READY',receipt.pid);
    const browser={version:()=> 'controlled browser protocol port',newBrowserCDPSession:async()=>({
        send:async method=>{if(method==='Extensions.loadUnpacked')return {id:'controlled-extension-port'};if(method!=='SystemInfo.getProcessInfo')throw Error('unsupported controlled CDP method '+method);console.log('OWNED_NODE_CDP_PID',receipt.pid);return {processInfo:[{type:'browser',id:receipt.pid}]};},detach:async()=>{}})};
    const close = async () => {
            console.log('OWNED_SESSION_CLOSED');
            if (process.env.AUDIT_BROWSER_FAILURE === 'close') throw new Error('controlled close failure');
            const stopped=await actorPort('audit-owner-stop',options.profileDir);
            if(!stopped.waited||!stopped.gone||!stopped.timerCleared||!stopped.fdClosed)throw Error('controlled owner close unconfirmed');
            console.log('OWNED_NODE_CLOSE_CONFIRMED',stopped.pid);
        };
    return {launchMode: 'macos-background-cdp', focusPolicy: 'launchservices-no-foreground',
        context: {on() {return this;}, off() {return this;}, serviceWorkers() {throw new Error('controlled readiness failure');}, browser() {return browser;}},
        windowPlacement: {browserFrontmost: false}, close, closeBrowserConnection: close,
        // Controlled ports have no process signal handlers to reroute.
        useGuardedClose(handler) {this.close = handler;}
    };
};
exports.newPageWithoutForeground = async () => {throw new Error('controlled readiness failure');};
exports.activateExtensionTabWithoutForeground = async () => {};
`);
    const preload = join(root, 'loaded.cjs');
    writeFileSync(preload, `const Module = require('node:module'); const original = Module._extensions['.js'];
Module._extensions['.js'] = (mod, file) => { if (file === process.argv[1]) console.log('ORIGINAL_CLI_LOADED', file); return original(mod, file); };
const http = require('node:http'); const originalClose = http.Server.prototype.close;
http.Server.prototype.close = function (...args) { this.once('close', () => console.log('OWNED_HTTP_SERVER_CLOSED')); return originalClose.apply(this, args); };
const fs = require('node:fs'); const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) { if (process.env.AUDIT_BROWSER_FAILURE === 'profile' && String(prefix).startsWith(process.env.TMPDIR) && String(prefix).includes('fr-service-config-')) throw new Error('controlled profile allocation failure'); return originalMkdtemp.call(this, prefix, ...args); };`);
    try {
        const result = await child(['--require', preload, join(sourceRoot, script), '--playwright-root', packages, '--focus-safe-helper', helper,
            '--artifacts-dir', join(root, 'artifacts'), '--extension-dir', extension, '--extension-install', 'command-line'], {TMPDIR: temp, AUDIT_BROWSER_FAILURE: mode, AUDIT_SCAN_ROOT: root,
            NODE_PATH: [join(workspaceRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter)});
        const profiles = readdirSync(temp);
        const retainedMarkers = profiles.map(profile => {const marker = join(temp, profile, 'uncertain-owner'); return existsSync(marker) ? readFileSync(marker, 'utf8') : null;});
        const profileEntries = profiles.map(profile => readdirSync(join(temp, profile)));
        const foreignSentinel = readFileSync(join(foreign, 'sentinel'), 'utf8');
        if (evidenceRoot) writeFileSync(join(evidenceRoot, `profiles-${serial}.json`), JSON.stringify({script, mode, profiles, retainedMarkers}, null, 2));
        const reportPath = join(root, 'artifacts', 'report.json');
        const report: Record<string, unknown> | null = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
        if (evidenceRoot) writeFileSync(join(evidenceRoot, `report-${serial}.json`), JSON.stringify({script, mode, report}, null, 2));
        return {result, profiles, retainedMarkers, profileEntries, foreignSentinel, report};
    } finally {
        try {await cleanupScanOwners(root, 'basic-browser-finally');}
        finally {expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('foreign fixture must survive');}
    }
}

describe('audit49 J public browser tooling ownership', () => {
    for (const script of ['scripts/run-input-translation-test.cjs', 'scripts/run-rich-text-input-editors-test.cjs', 'scripts/testing/run-image-encoding-performance.cjs', 'scripts/run-video-subtitle-settings-test.cjs', 'scripts/testing/run-free-routing-browser-test.cjs', 'scripts/testing/run-service-configuration-ui-test.cjs']) {
        it(`${script}: rejected initialization retains its empty profile after a launch attempt`, async () => {
            const {result, profiles, profileEntries, foreignSentinel} = await browserFailure(script, 'launch');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled launch failure');
            // Previously an absent session authorized rmdir of an empty profile.
            // A rejected launch now retains it; an empty directory cannot establish exit.
            expect(profiles).toHaveLength(1);
            expect(profileEntries).toEqual([[]]);
            expect(foreignSentinel).toBe('foreign fixture must survive');
            expect(result.stdout).not.toContain('OWNED_SESSION_CLOSED');
        });
        it(`${script}: rejected partial initialization retains its nonempty profile`, async () => {
            const {result, profiles, retainedMarkers} = await browserFailure(script, 'partial-launch');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled launch failure');
            expect(profiles).toHaveLength(1);
            expect(retainedMarkers).toEqual(['owned initialization sentinel']);
        });
        it(`${script}: readiness failure closes the acquired session and removes its profile`, async () => {
            const {result, profiles} = await browserFailure(script, 'ready');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled readiness failure');
            expect(profiles).toEqual([]);
        });
    }
    it('free routing closes its local server when acquired browser closure rejects', async () => {
        const {result, profiles} = await browserFailure('scripts/testing/run-free-routing-browser-test.cjs', 'close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
        expect(result.stdout + result.stderr).toContain('controlled close failure');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    }, 12000);
    it('service configuration reports a profile allocation error before launch', async () => {
        const {result, profiles, report} = await browserFailure('scripts/testing/run-service-configuration-ui-test.cjs', 'profile');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
        expect(report).toMatchObject({ok: false});
        expect(report?.error).toContain('controlled profile allocation failure');
    });
    it('service configuration retains its profile when the acquired browser cannot confirm closure', async () => {
        const {result, profiles} = await browserFailure('scripts/testing/run-service-configuration-ui-test.cjs', 'close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
        expect(result.stdout + result.stderr).toContain('controlled readiness failure');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    });
});

interface PlanProbeReport {
    status: string;
    paths: {json: string; summary: string; repairPlan: string};
    steps: {id: string; status: string; exitCode: number | null; signal: string | null; error: string | null;
        startedAt: string; finishedAt: string; durationMs: number; logPath: string}[];
}

async function planChild(command: string, args: string[]) {
    // Process/report contracts own a temporary cwd; snapshot Git status is unrelated and can scan large copied trees.
    const entry = join(fixtureRoot, `plan-${++serial}.mjs`);
    const artifactsDir = join(fixtureRoot, `plan-artifacts-${serial}`);
    writeFileSync(entry, `import {executePlan} from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/testing/run-full-regression.mjs')).href)};
console.log('ORIGINAL_PUBLIC_RUNNER_LOADED');
try {
 const report=await executePlan({version:3,mode:'contract-fixture',dryRun:false,artifactsDir:${JSON.stringify(artifactsDir)},
  failFast:false,continueOnError:true,policies:{browser:'disabled',network:'disabled',headed:'disabled'},
  steps:[{id:'controlled-step',phase:'local',command:${JSON.stringify(command)},args:${JSON.stringify(args)},label:'controlled step',gates:[],dependsOn:[]}]}, {cwd:${JSON.stringify(fixtureRoot)}});
 console.log('PLAN_RESULT '+JSON.stringify(report));console.log('PLAN_FINISHED');process.exitCode=report.status==='passed'?0:1;
}
catch (error) {console.error('PLAN_REJECTED', error.message); process.exitCode=17;}`);
    const result = await child([entry], {});
    const returned = JSON.parse(/^PLAN_RESULT (.+)$/m.exec(result.stdout)![1]) as PlanProbeReport;
    const persisted = JSON.parse(readFileSync(join(artifactsDir, 'report.json'), 'utf8')) as PlanProbeReport;
    expect(persisted).toEqual(returned);
    expect(existsSync(join(artifactsDir, '.regression.lock'))).toBe(false);
    expect(existsSync(persisted.paths.summary)).toBe(true);
    expect(existsSync(persisted.paths.repairPlan)).toBe(true);
    expect(persisted.steps).toHaveLength(1);
    expect(persisted.steps[0].startedAt).toEqual(expect.any(String));
    expect(persisted.steps[0].finishedAt).toEqual(expect.any(String));
    expect(persisted.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stdout).toContain('PLAN_FINISHED');
    expect(result.stderr).not.toContain('PLAN_REJECTED');
    return {...result, report: persisted, log: readFileSync(persisted.steps[0].logPath, 'utf8')};
}

describe('audit49 J public bounded regression orchestration', () => {
    it('returns and persists a failed report for a child spawn error without an unhandled error', async () => {
        const result = await planChild(join(fixtureRoot, 'nonexistent-command'), []);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_PUBLIC_RUNNER_LOADED');
        expect(result.code).toBe(1);
        expect(result.report.status).toBe('failed');
        expect(result.report.steps[0]).toMatchObject({id: 'controlled-step', status: 'failed', signal: null, error: expect.stringContaining('ENOENT')});
        expect(result.log).toContain('ENOENT');
        expect(result.stdout).toContain('[regression] controlled step ->');
        expect(result.stderr).not.toContain("Unhandled 'error' event");
    });
    it('preserves a real child nonzero exit as step failure', async () => {
        const result = await planChild(process.execPath, ['-e', 'console.error("CONTROLLED_CHILD_EXECUTED");process.exitCode = 23;']);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.report.status).toBe('failed');
        expect(result.report.steps[0]).toMatchObject({id: 'controlled-step', status: 'failed', exitCode: 23, signal: null, error: null});
        expect(result.stderr).toContain('CONTROLLED_CHILD_EXECUTED');
        expect(result.log).toContain('CONTROLLED_CHILD_EXECUTED');
    });
    it('waits for a successful real child before completing the plan', async () => {
        const result = await planChild(process.execPath, ['-e', 'setTimeout(() => console.log("CONTROLLED_CHILD_FINISHED"), 30);']);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.report.status).toBe('passed');
        expect(result.report.steps[0]).toMatchObject({status: 'passed', exitCode: 0, signal: null, error: null});
        expect(result.log).toContain('CONTROLLED_CHILD_FINISHED');
        expect(result.stdout.indexOf('CONTROLLED_CHILD_FINISHED')).toBeGreaterThan(-1);
        expect(result.stdout.indexOf('PLAN_FINISHED')).toBeGreaterThan(result.stdout.indexOf('CONTROLLED_CHILD_FINISHED'));
    });
});


// Continuation2 ports implement external browser/OS protocols only. The production
// CLI and its consumer callbacks execute unchanged; no native/product UI proof.
async function portCLI(script: string, mode: string, extra: string[] = []) {
    const root = mkdtempSync(join(fixtureRoot, 'continuation2-'));
    const temp = join(root, 'profiles'); mkdirSync(temp);
    const extension = join(root, 'chrome-mv3'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({name: 'FluentRead', version: '1.0', background: {service_worker: 'background.js'}, action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}));
    // Public artifact preflights need actual files, although the controlled
    // launcher stops before any of this fixture JavaScript can execute.
    writeFileSync(join(extension, 'background.js'), '// controlled external artifact fixture');
    mkdirSync(join(extension, 'content-scripts'));
    writeFileSync(join(extension, 'content-scripts/content.js'), '// controlled external artifact fixture');
    for (const file of ['localTtsWorker.js', 'videoTranscriptionWorker.js']) writeFileSync(join(extension, file), '// controlled fixture');
    const artifact = join(root, 'fixture.user.js'); writeFileSync(artifact, '// controlled fixture artifact, never executed');
    const foreign = join(root, 'foreign-profile'); mkdirSync(foreign);
    writeFileSync(join(foreign, 'sentinel'), 'foreign fixture must survive');
    const packages = join(root, 'packages');
    const ports = join(root, 'ports.cjs');
    writeFileSync(ports, String.raw`
const {EventEmitter} = require('node:events'); const fs = require('node:fs'); const path = require('node:path');
const mode = process.env.AUDIT_PORT_MODE; const timer = global.__auditRealTimer || setTimeout; const pause = ms => new Promise(resolve => timer(resolve, ms));
// Keep IPC referenced only while awaiting an actual parent-owned actor receipt.
// Otherwise a rejected public CLI must be able to exit normally on its own.
process.channel?.unref();
function actorPort(type,profileDir){return new Promise((resolve,reject)=>{
 const timeout=timer(()=>{process.off('message',message);process.channel?.unref();reject(Error('controlled actor port timeout'));},6500);
 function message(receipt){if(receipt?.type!==type+'-receipt')return;clearTimeout(timeout);process.off('message',message);process.channel?.unref();if(receipt.error)reject(Error(receipt.error));else resolve(receipt);}
 process.on('message',message);process.channel?.ref();process.send({type,profileDir});
});}
let checks = 0, ready = false, scanned = false; const born = Date.now();
const worker = {url: () => 'chrome-extension://fixture/background.js', evaluate: async () => {checks++; if(mode==='worker-initial')await pause(20); return {action:{default_popup:'popup.html'},options_ui:{page:'options.html'}};}};
const context = new EventEmitter();
context.serviceWorkers = () => {
 if(mode === 'focus' && Date.now()-born < 1180) return [];
 if(mode==='worker-initial')return [worker,{url:()=> 'chrome-extension://fast/background.js',evaluate:async()=>{checks++;return {action:{default_popup:'popup.html'},options_ui:{page:'options.html'}};}}];
 if(mode.startsWith('worker')) {
  if(mode === 'worker-race' && !scanned){scanned=true;queueMicrotask(()=>{ready=true;context.emit('serviceworker', worker);});}
  return ready ? [worker] : [];
 }
 throw new Error('controlled readiness failure');
};
let ownedProfile, ownedPid;
async function startOwned(profileDir){
 const receipt=await actorPort('audit-owner-start',profileDir);
 if(!receipt.actualOwnedHandle||!Number.isSafeInteger(receipt.pid)||receipt.pid<=0||!receipt.psNative||receipt.profileArgument!=='--user-data-dir='+profileDir)throw Error('controlled actor ownership missing');
 ownedProfile=profileDir;ownedPid=receipt.pid;global.__auditOwnedActorPid=ownedPid;
 console.log('OWNED_NODE_READY',ownedPid);
}
const browserPort={version:()=> 'controlled browser protocol port',newBrowserCDPSession:async()=>({
 send:async method=>{if(method!=='SystemInfo.getProcessInfo')throw Error('unsupported controlled CDP method '+method);if(!Number.isSafeInteger(ownedPid)||ownedPid<=0)throw Error('controlled actor PID unavailable');
  if(mode==='scan-capture-query-empty'){console.log('OWNED_NODE_CDP_QUERY_THROW',ownedPid);throw Error('controlled acquired-empty CDP query failure');}
  console.log('OWNED_NODE_CDP_PID',ownedPid);return {processInfo:[{type:'browser',id:ownedPid}]};},
 detach:async()=>{if(mode==='scan-capture-query-empty')console.log('OWNED_NODE_CDP_DETACHED',ownedPid);}})};
context.browser = () => browserPort;
// The original public video body consumes complete external page/CDP ports.
// Fail its metrics request deliberately, after it has acquired the CDP client;
// do not rely on an undefined method or patch any CLI consumer callback.
const videoCLI = path.basename(process.argv[1]) === 'run-video-performance-test.cjs';
const videoPage = {
 on(){},
 async goto(){console.log('VIDEO_PUBLIC_GOTO');},
 async waitForTimeout(milliseconds){console.log('VIDEO_PUBLIC_WAIT',milliseconds);},
};
if(videoCLI && mode.startsWith('scan-')) context.newCDPSession = async selectedPage => {
 if(selectedPage !== videoPage) throw new Error('controlled video page identity mismatch');
 console.log('VIDEO_CDP_CLIENT_ACQUIRED');
 return {
  async send(method){
   if(method === 'Performance.enable'){console.log('VIDEO_PERFORMANCE_ENABLED');return {};}
   if(method === 'Performance.getMetrics'){
    console.log('VIDEO_PUBLIC_BODY_FAILURE',method);
    throw new Error('controlled video metrics failure');
   }
   throw new Error('unsupported controlled video CDP method '+method);
  },
  async detach(){
   console.log('VIDEO_CDP_DETACH');
   if(mode === 'scan-video-body-close') throw new Error('controlled video detach failure');
  },
 };
};
const close = async () => {
 console.log('SESSION_CLOSE');
 if(mode.startsWith('worker')) {await pause(100); context.emit('serviceworker',worker); await pause(20); console.log('WORKER_FINAL',JSON.stringify({listeners:context.listenerCount('serviceworker'),checks}));}
 if(mode.endsWith('close')) throw new Error('controlled close failure');
 if(ownedProfile){
  const receipt=await actorPort('audit-owner-stop',ownedProfile);
  if(!receipt.waited||!receipt.gone||!receipt.timerCleared||!receipt.fdClosed)throw Error('controlled owner close unconfirmed');
  if(mode==='scan-capture-query-empty'&&(!receipt.psAbsent||!receipt.lockRemoved))throw Error('controlled empty owner close unconfirmed');
  console.log('OWNED_NODE_CLOSE_CONFIRMED',receipt.pid);
 }
};

let db, abortEnabled = false, writeTransactions = 0;
const state = {config:{service:'deeplx'}, service:'', source:'', status:'', sorted:false, order:0};
async function setupIDB() {
 const {IDBFactory,IDBDatabase} = require(process.env.AUDIT_WORKSPACE+'/node_modules/fake-indexeddb');
 global.indexedDB = new IDBFactory();
 db = await new Promise((resolve,reject)=>{const req=indexedDB.open('FluentReadTranslationStats',1);req.onupgradeneeded=()=>{for(const name of ['requests','rollups','routes'])req.result.createObjectStore(name,{keyPath:'id',autoIncrement:true});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 await new Promise((resolve,reject)=>{const tx=db.transaction(['requests','rollups'],'readwrite');for(let i=0;i<10;i++)tx.objectStore('requests').put({id:'record-'+i,serviceId:i<7?'deeplx':'custom:stats-fixture',model:i<7?'':'stats-model',source:'network',startedAt:Date.now()-i*1000,durationMs:1300-i*100});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
 const transact=IDBDatabase.prototype.transaction, closeDb=IDBDatabase.prototype.close;
 IDBDatabase.prototype.close=function(...args){if(abortEnabled)console.log('IDB_CLOSE');return closeDb.apply(this,args);};
 IDBDatabase.prototype.transaction=function(stores,kind,...args){
  const tx=transact.call(this,stores,kind,...args);
  if(kind!=='readwrite'||!abortEnabled)return tx;
  const number=++writeTransactions;
  if((mode==='idb-seed'&&number!==1)||(mode==='idb-paging'&&number!==2))return tx;
  const store=tx.objectStore;const wrapped=new WeakSet();let issued=0,completed=0,requestErrors=0;
  tx.addEventListener('error',()=>console.log('IDB_TX_ERROR'));
  tx.addEventListener('abort',()=>console.log('IDB_ABORT_ONLY',JSON.stringify({issued,completed,requestErrors})));
  tx.objectStore=function(...parameters){const object=store.apply(this,parameters);if(wrapped.has(object))return object;wrapped.add(object);const put=object.put;object.put=function(...values){const req=put.apply(this,values);issued++;req.addEventListener('error',()=>requestErrors++);req.addEventListener('success',()=>{if(++completed===issued)tx.abort();});return req;};return object;};
  return tx;
 };
}
const cache=new Map();
global.chrome={runtime:{sendMessage:async message=>{
 if(message.type==='configStorageRead')return {success:true,value:state.config};
 if(message.type==='persistConfig'){Object.assign(state.config,message.config);return {success:true};}
 if(Object.hasOwn(message,'origin')){
  const key=JSON.stringify(message.origin);if(cache.has(key))return cache.get(key);
  const text=Array.isArray(message.origin)?message.origin.join('\n'):message.origin;
  const ai=message.serviceOverride!=='deeplx';
  const url=ai?state.config.customOpenAIProviders[0].endpoint:state.config.deeplx;
  const task=fetch(url,{method:'POST',body:JSON.stringify(ai?{messages:[{role:'user',content:'SOURCE_BEGIN'+text+'SOURCE_END'}]}:{text})}).then(response=>response.status===429?{kind:'rate-limit',statusCode:429}:'controlled translation');cache.set(key,task);return task;
 }
 throw new Error('unsupported controlled runtime message');
}}};
function logRecords(){
 if(state.status==='失败')return [{text:'频率或额度受限 · HTTP 429',source:'network',duration:'300 毫秒'}];
 if(state.source==='部分缓存')return [{text:'Stats fixture 2 段',source:'is-partial',duration:'300 毫秒'}];
 const count=state.service==='Stats fixture'?3:state.service==='DeepLX'?7:10;
 return Array.from({length:count},(_,i)=>({text:'DeepLX controlled metadata',source:i===1?'is-cache':i===2?'is-partial':i===3?'is-shared':'network',duration:(1300-i*100)+' 毫秒'}));
}
function locator(selector,index=0){return {
 first(){return locator(selector,0);},last(){return locator(selector,99);},nth(n){return locator(selector,n);},locator(child){return locator(selector+' '+child,index);},filter(value){return locator(selector+' FILTER '+value.hasText,index);},
 getByRole(role,options){return locator(selector+' OPTION '+options.name,index);},
 async waitFor(){},async scrollIntoViewIfNeeded(){},async click(){
  const option=/OPTION (.+)$/.exec(selector);if(option){if(['失败','全部状态'].includes(option[1]))state.status=option[1];else state.source=option[1];}
  const service=/FILTER (.+)$/.exec(selector);if(service)state.service=state.service===service[1]?'':service[1];
  if(selector.includes('.stats-log .stats-toggle')&&index===1)state.sorted=true;
  if(selector.includes('.stats-service-table thead .stats-sort'))state.order++;
 },
 async count(){if(selector.includes('.stats-service-table tbody'))return 2;if(selector.includes('.stats-routes'))return state.service==='免费翻译'?1:0;if(selector.includes('.stats-route-table'))return 3;if(selector.includes('.stats-trend-bar'))return 24;throw new Error('unexpected fixture count '+selector);},
 async allTextContents(){return ['成功率 90%','300 毫秒','最长 1.3 秒','25%'];},
 async textContent(){if(selector.includes('[data-section='))return '翻译统计';if(selector.includes('.stats-failures'))return '频率或额度受限 1';if(selector.includes('.stats-summary .stats-card-value'))return '300 毫秒';if(selector.includes('.stats-route-table'))return index===2?'DeepLX':'微软翻译 83.3%';if(selector.includes('.stats-service-table'))return state.order?'Stats fixture stats-model':'DeepLX';throw new Error('unexpected fixture text '+selector);},
 async getAttribute(){return selector.includes('aria-pressed')?'true':selector.includes('.stats-trend .stats-toggle')?'true':'ascending';},
 async evaluateAll(){return logRecords();},async evaluate(){if(selector.includes('.stats-routes'))return true;throw new Error('unexpected fixture evaluate '+selector);}
};}
const page={on(){},async goto(){},async setViewportSize(){},async screenshot(){},locator,
 async waitForFunction(){},
 async evaluate(fn,arg){
  if(arg&&Array.isArray(arg.routes)&&Array.isArray(arg.freeRequests)){abortEnabled=true;console.log('PUBLIC_IDB_SEED_CALLBACK');}
  // The actual callback provided by the unchanged public CLI runs against the
  // controlled browser-global ports and real IndexedDB implementation.
  return await Reflect.apply(fn,undefined,[arg]);
 }
};
if(mode.startsWith('idb'))context.serviceWorkers=()=>[worker];

exports.chromium={};
exports.webkit={launch:async()=>{
 console.log('WEBKIT_LAUNCHED');
 // The original WebKit CLI allocates this dedicated profile before launch;
 // only this fixture directory is searched, never the process table or user data.
 const profiles=fs.readdirSync(process.env.TMPDIR,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name.startsWith('fluentread-userscript-edge-'));
 if(profiles.length!==1)throw Error('controlled WebKit profile unavailable');
 await startOwned(path.join(process.env.TMPDIR,profiles[0].name));
 return {...browserPort,context,newContext:async()=>{throw new Error('controlled newContext failure');},close};
}};
exports.launchFocusSafePersistentContext = async options => {
 console.log('PUBLIC_LAUNCH_REACHED');
 await startOwned(options.profileDir);
 if(mode==='scan-partial') {fs.writeFileSync(path.join(options.profileDir,'uncertain-owner'),'controlled active profile');throw new Error('controlled partial launch failure');}
 // Fail the external launcher after the parent starts a live actor; return no session.
 if(mode==='scan-partial-empty') {console.log('PARTIAL_EMPTY_LAUNCH_REJECTED',ownedPid);throw new Error('controlled live-empty partial launch failure');}
 if(mode.startsWith('idb'))await setupIDB();
 if(mode === 'worker-event') timer(()=>{ready=true;context.emit('serviceworker',worker);},10);
 return {context,close,closeBrowserConnection:close,
  // Controlled ports have no process signal handlers to reroute.
  useGuardedClose(handler){this.close=handler;},
  launchMode:'macos-background-cdp',focusPolicy:'launchservices-no-foreground',windowPlacement:{mode:'background-visible-no-focus',browserFrontmost:false}};
};
exports.newPageWithoutForeground = async () => {console.log('PUBLIC_AFTER_WORKER');if(videoCLI && mode.startsWith('scan-'))return videoPage;if(mode.startsWith('idb'))return page;if(mode==='worker-initial')return {setViewportSize:async()=>{},goto:async url=>{console.log('SELECTED_WORKER_URL',url);throw new Error('controlled readiness failure');}};throw new Error('controlled readiness failure');};
exports.activateExtensionTabWithoutForeground=async()=>{};
// Keep the production monitor's ready parser, permanent error and stop owner;
// only its external compiler/process ports are controlled, never native focus.
exports.startFocusEventMonitor = options => {
 const {createFocusEventMonitor}=require(process.env.AUDIT_WORKSPACE+'/scripts/testing/mac-focus-event-monitor.cjs');
 const directory=path.join(process.env.TMPDIR,'controlled-focus-observer');
 let spawned=false,closed=false;
 const observer=Object.assign(new EventEmitter(),{pid:process.pid,stdout:new EventEmitter(),stderr:new EventEmitter()});
 observer.stdin=Object.assign(new EventEmitter(),{end:value=>{
  if(value!=='stop\n')throw Error('controlled focus observer stop protocol mismatch');
  console.log('FOCUS_OBSERVER_STOP_REQUESTED');queueMicrotask(()=>{closed=true;console.log('FOCUS_OBSERVER_CLOSED');observer.emit('close',0,null);});
 }});
 observer.kill=()=>{throw Error('unexpected controlled focus observer escalation');};
 const monitor=createFocusEventMonitor(options,{
  compile:async()=>{console.log('FOCUS_OBSERVER_COMPILE_PORT');fs.mkdirSync(directory);if(mode==='scan-focus-ready-failure')throw Error('controlled focus compile failure');return path.join(directory,'observer');},
  spawn:()=>{spawned=true;console.log('FOCUS_OBSERVER_ACQUIRED');queueMicrotask(()=>observer.stdout.emit('data',Buffer.from(JSON.stringify({kind:'ready',pid:observer.pid,time:1000,monotonicMs:10})+'\n')));return observer;},
  cleanup:async()=>{if(spawned&&!closed)throw Error('controlled focus observer cleanup before close');fs.rmSync(directory,{recursive:true,force:true});console.log('FOCUS_OBSERVER_CLEANUP');},
 });
 void monitor.ready.then(()=>console.log('FOCUS_OBSERVER_READY'),()=>{});
 return monitor;
};
exports.queryMacFrontmostApplication=async()=>({pid:process.pid,name:'controlled external foreground port'});
`);
    for (const directory of [join(packages, 'playwright'), join(packages, 'node_modules/playwright')]) {
        mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'index.js'), `module.exports=require(${JSON.stringify(ports)});`);
    }
    const preload = join(root, 'preload.cjs');
    writeFileSync(preload, String.raw`
const Module = require('node:module'); const original = Module._extensions['.js'];
Module._extensions['.js']=(mod,file)=>{
 if(file===process.argv[1]){
  console.log('ORIGINAL_CLI_LOADED',file);
  // The site CLI reads process.platform directly. Give only that consumer a
  // controlled OS value while preserving native platform/ownership in every
  // dependency and in the parent-owned process. Its source and callbacks run
  // unchanged; only the lexical external process port is substituted.
  if(file.endsWith('/run-site-translation-test.cjs')&&process.env.AUDIT_PORT_MODE.startsWith('scan-')){
   const actualCompile=mod._compile, consumerPlatform=process.env.AUDIT_PORT_MODE==='scan-site-platform-block'?'unsupported-fixture-platform':'darwin';
   console.log('CONTROLLED_SITE_PLATFORM_PORT',JSON.stringify({hostPlatform:process.platform,consumerPlatform}));
   mod._compile=function(source,filename){
    const newline=source.indexOf('\n');if(!source.startsWith('#!')||newline<0)throw Error('controlled site CLI entry format changed');
    const binding='const process = new Proxy(globalThis.process, {get(target, key) {return key === "platform" ? '+JSON.stringify(consumerPlatform)+' : Reflect.get(target, key, target);}});\n';
    return actualCompile.call(this,source.slice(0,newline+1)+binding+source.slice(newline+1),filename);
   };
  }
 }
 return original(mod,file);
};
// Only the selected CLI's OS capability is a controlled external port. Its
// production macOS gate still runs; dependencies retain the host OS module and
// real process.platform, including Linux /proc start identity and native ps.
const nativeLoad=Module._load;
Module._load=function(request,parent,...args){
 const loaded=nativeLoad.call(this,request,parent,...args);
 const entry=parent?.filename===process.argv[1];
 const mode=process.env.AUDIT_PORT_MODE;
 const macConsumer=process.argv[1].endsWith('/run-ai-context-ui-test.cjs')||process.argv[1].endsWith('/run-translation-stats-ui-test.cjs');
 if(request==='node:os'&&entry&&macConsumer&&(mode.startsWith('scan-')||mode.startsWith('idb')||mode==='platform-block')){
  const consumerPlatform=mode==='platform-block'?'unsupported-fixture-platform':'darwin';
  console.log('CONTROLLED_MACOS_PLATFORM_PORT',JSON.stringify({hostPlatform:process.platform,consumerPlatform}));
  return {...loaded,platform:()=>consumerPlatform};
 }
 return loaded;
};
if(process.env.AUDIT_PORT_MODE.startsWith('scan-')) {
 const fs=require('node:fs'),path=require('node:path');
 const root=path.dirname(__filename),ports=path.join(root,'ports.cjs');
 const load=Module._load;
 Module._load=function(request,parent,...args){if(request==='playwright'||String(request).endsWith('/playwright')||String(request).endsWith('focus-safe-browser.cjs'))return load.call(this,ports,parent,...args);return load.call(this,request,parent,...args);};
 const mkdir=fs.mkdtempSync;fs.mkdtempSync=function(prefix,...args){if(String(prefix).startsWith('/private/tmp/'))prefix=path.join(process.env.TMPDIR,path.basename(prefix));return mkdir.call(this,prefix,...args);};
 const cp=require('node:child_process'),util=require('node:util');
 const native={execFile:cp.execFile,execFileSync:cp.execFileSync,spawnSync:cp.spawnSync};
 const foreground=(file,args)=>file==='/usr/bin/osascript'&&Array.isArray(args)&&args.length===4&&args[0]==='-l'&&args[1]==='JavaScript'&&args[2]==='-e'&&typeof args[3]==='string'&&args[3].includes('frontmostApplication');
 const fake=(file,args,options,callback)=>{if(!foreground(file,args))return native.execFile.call(cp,file,args,options,callback);console.log('CONTROLLED_FOCUS_PORT');queueMicrotask(()=>callback(null,JSON.stringify({pid:process.pid,name:'controlled external foreground port'}),''));};
 fake[util.promisify.custom]=(...args)=>new Promise((resolve,reject)=>fake(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));cp.execFile=fake;
 const media=file=>file==='/usr/bin/say'||file==='/usr/bin/afconvert'||typeof file==='string'&&['ffmpeg','ffprobe'].includes(path.basename(file));
 const sync=(file,args,options)=>{console.log('CONTROLLED_NATIVE_SETUP_PORT',file);for(const value of args||[]){if(typeof value==='string'&&/\.(?:mp4|wav|aiff|m4s|m3u8)$/.test(value)&&fs.existsSync(path.dirname(value))){const owner=fs.realpathSync(root),parent=fs.realpathSync(path.dirname(value));if(parent===owner||parent.startsWith(owner+path.sep))fs.writeFileSync(value,'controlled media fixture');}}return {status:0,stdout:JSON.stringify({format:{duration:'30'},streams:[{duration:'30'}]}),stderr:''};};
 // In particular /bin/ps, bare ps and every unselected executable reach the
 // untouched native methods. No process observation is an external fixture port.
 cp.spawnSync=function(file,args,options){if(!media(file))return native.spawnSync.call(this,file,args,options);return sync(file,args,options);};
 cp.execFileSync=function(file,args,options){if(foreground(file,args)){console.log('CONTROLLED_FOCUS_PORT');return JSON.stringify({pid:process.pid,name:'controlled external foreground port'});}if(!media(file))return native.execFileSync.call(this,file,args,options);return sync(file,args,options).stdout;};
}
const realResolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...args){try{return realResolve.call(this,request,parent,...args);}catch(error){if(request==='./local-model-browser-helpers.cjs')return process.env.AUDIT_WORKSPACE+'/scripts/testing/local-model-browser-helpers.cjs';throw error;}};
const mode=process.env.AUDIT_PORT_MODE; const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), cp=require('node:child_process'), util=require('node:util');
const close=http.Server.prototype.close;http.Server.prototype.close=function(...args){this.once('close',()=>console.log('OWNED_HTTP_SERVER_CLOSED'));return close.apply(this,args);};
if(mode==='scan-server-startup'){
 const listen=http.Server.prototype.listen;let attempts=0;
 http.Server.prototype.listen=function(...args){
  if(++attempts===2){queueMicrotask(()=>this.emit('error',new Error('controlled second fixture server bind failure')));return this;}
  return listen.apply(this,args);
 };
}
const write=fs.writeFileSync;let failed=false;fs.writeFileSync=function(file,...args){if(mode.startsWith('report')&&!failed&&['report.json','firefox-config-persistence.json'].includes(path.basename(String(file)))){failed=true;console.log('REPORT_WRITE_FAILED');throw new Error('controlled report write failure');}return write.call(this,file,...args);};
if(mode==='scan-report'||mode==='scan-report-close'){fs.writeFileSync=function(file,...args){if(!failed&&['report.json','summary.json','result.json','browser-report.json'].includes(path.basename(String(file)))){failed=true;console.log('REPORT_WRITE_FAILED');throw new Error('controlled report write failure');}return write.call(this,file,...args);};}
const realTimer=setTimeout;global.__auditRealTimer=realTimer;if(mode.startsWith('worker'))global.setTimeout=(callback,ms,...args)=>realTimer(callback,ms===30000?60:ms,...args);
if(mode==='focus'||mode.startsWith('idb')){
 const nativeExecFile=cp.execFile;
 const foreground=(file,args)=>file==='/usr/bin/osascript'&&Array.isArray(args)&&args.length===4&&args[0]==='-l'&&args[1]==='JavaScript'&&args[2]==='-e'&&typeof args[3]==='string'&&args[3].includes('frontmostApplication');
 const fake=(file,args,options,callback)=>{
  if(!foreground(file,args))return nativeExecFile.call(cp,file,args,options,callback);
  console.log('MONITOR_STARTED');return realTimer(()=>{
   console.log('MONITOR_RESULT');const pid=mode==='focus'?global.__auditOwnedActorPid:process.pid;
   if(!Number.isSafeInteger(pid)||pid<=0){callback(Error('controlled foreground actor PID unavailable'),'','');return;}
   // External foreground protocol deliberately matches the real owned actor in
   // focus mode, so the public consumer still takes its foreground-error path.
   callback(null,JSON.stringify({pid,name:'controlled external foreground port'}),'');
  },mode==='focus'?300:0);
 };
 fake[util.promisify.custom]=(...args)=>new Promise((resolve,reject)=>fake(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));cp.execFile=fake;
}
if(mode.startsWith('native')) {
 const spawn=cp.spawn, sync=cp.execFileSync;
 const selected=file=>file==='/usr/bin/say'||file==='/usr/bin/afconvert';
 const cmdArgs=file=>['-e',mode==='native-convert'&&file==='/usr/bin/say'?'process.exit(0)':'process.on("SIGTERM",()=>console.log("NATIVE_TERM_RECEIVED"));console.log("NATIVE_CHILD_LOADED");setInterval(()=>{},1000)'];
 cp.spawn=function(file,args,options){if(!selected(file))return spawn.call(this,file,args,options);console.log('NATIVE_PORT_REACHED',file,JSON.stringify(args));return spawn.call(this,mode==='native-spawn-error'?'/controlled-nonexistent-native-command':process.execPath,cmdArgs(file),options);};
 cp.execFileSync=function(file,args,options){if(!selected(file))return sync.call(this,file,args,options);console.log('NATIVE_PORT_REACHED',file,JSON.stringify(args));return sync.call(this,mode==='native-spawn-error'?'/controlled-nonexistent-native-command':process.execPath,cmdArgs(file),{...options,stdio:'inherit'});};
}
`);
    const flags = script.endsWith('run-userscript-smoke-test.cjs')
        ? ['--artifact', artifact, '--engine', 'webkit', '--browser-path', process.execPath]
        : ['--extension-dir', extension, '--extension-install', 'command-line'];
    if (mode.startsWith('scan-')) {
        // These are entry-specific public arguments, not a permissive argv
        // rewrite. In particular --background is a flag in strict parsers.
        flags.splice(0, flags.length, '--extension-dir', extension, '--browser-path', process.execPath);
        const mediaDir = join(root, 'media'); mkdirSync(mediaDir);
        writeFileSync(join(mediaDir, 'video-direct.mp4'), 'controlled media fixture, never decoded');
        if (script.endsWith('run-x-native-subtitle-test.cjs') || script.endsWith('run-reported-fixes-test.cjs')) flags.push('--media-dir', mediaDir, '--extension-install', 'command-line');
        if (script.endsWith('run-site-translation-test.cjs')) {
            const diagnosticHelper = join(root, 'runtime-diagnostics.cjs');
            writeFileSync(diagnosticHelper, `module.exports={redact:String,createRuntimeDiagnostics:()=>({start:async()=>{},attachPage:async()=>{},setExtensionId(){},setPhase(){},flush:async()=>{},snapshot:()=>({passed:false,completeCoverage:false}),assertClean(){},stop:async()=>{}})};`);
            flags.push('--case', 'example-com', '--mode', 'hover', '--allow-network', '--runtime-diagnostics-helper', diagnosticHelper);
        }
        if (script.endsWith('run-translation-viewport-test.cjs')) flags.push('--allow-network');
    }
    try {
        const result = await child(['--require', preload, join(sourceRoot, script), '--playwright-root', packages, '--focus-safe-helper', ports, '--artifacts-dir', join(root, 'artifacts'), ...flags, ...extra],
            {TMPDIR: temp, AUDIT_PORT_MODE: mode, AUDIT_WORKSPACE: workspaceRoot, AUDIT_SCAN_ROOT: root, ...(mode === 'native-cancel' ? {AUDIT_CANCEL_ON_MARKER: 'NATIVE_CHILD_LOADED'} : {}), NODE_PATH: join(workspaceRoot, 'node_modules')});
        const profiles = readdirSync(temp);
        const reportPath = join(root, 'artifacts/report.json');
        const report: Record<string, any> | null = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
        if (evidenceRoot) writeFileSync(join(evidenceRoot, `port-${serial}.json`), JSON.stringify({script, mode, profiles, report}, null, 2));
        const owners = scanOwners.get(root) || [];
        // Guard-initiated TERM can precede the CLI's exit. Join this parent's actual
        // ChildProcess close before reading final FD/timer receipts for gone actors.
        for (const owner of owners) if (ownerGone(owner)) await bounded(owner.closed, 1500);
        const ownerStates = owners.map(owner => ({pid: owner.child.pid, profile: owner.profile, gone: ownerGone(owner), profileExists: existsSync(owner.profile), timerCleared: owner.output.includes('"timerCleared":true'), fdClosed: owner.output.includes('"fdClosed":true')}));
        const unacquiredEmpty = mode === 'scan-partial-empty' ? {
            receipts: scanProcessReceipts.filter(receipt => owners.some(owner => owner.profile === receipt.profile)),
            profiles: owners.map(owner => ({profile: owner.profile, exists: existsSync(owner.profile), entries: existsSync(owner.profile) ? readdirSync(owner.profile) : null})),
            foreignSentinel: readFileSync(join(foreign, 'sentinel'), 'utf8'),
            nativeRows: [] as {pid: number | undefined; stdout: string}[],
            actorExits: [] as {pid: number | undefined; receipt: Record<string, unknown>}[],
        } : null;
        if (unacquiredEmpty) {
            // Read native ps again after the original CLI exits, while this parent
            // still holds the actor handle. No CLI preload can alter these rows.
            for (const owner of owners) {
                const stdout = await bounded(new Promise<string>((resolveSnapshot, rejectSnapshot) => {
                    execFile('/bin/ps', ['-ww', '-p', String(owner.child.pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='],
                        {encoding: 'utf8', timeout: 750, maxBuffer: 1024 * 1024, env: {...process.env, LC_ALL: 'C'}},
                        (error, output) => error ? rejectSnapshot(error) : resolveSnapshot(output));
                }), 1500);
                unacquiredEmpty.nativeRows.push({pid: owner.child.pid, stdout});
            }
            if (evidenceRoot) writeFileSync(join(evidenceRoot, `unacquired-empty-${serial}.json`), JSON.stringify({script, mode, ...unacquiredEmpty}, null, 2));
        }
        const emptyCapture = mode === 'scan-capture-query-empty' ? {
            receipts: scanProcessReceipts.filter(receipt => owners.some(owner => owner.profile === receipt.profile)),
            profiles: owners.map(owner => ({profile: owner.profile, exists: existsSync(owner.profile), entries: existsSync(owner.profile) ? readdirSync(owner.profile) : null})),
            foreignSentinel: readFileSync(join(foreign, 'sentinel'), 'utf8'),
        } : null;
        if (evidenceRoot && emptyCapture) writeFileSync(join(evidenceRoot, `empty-capture-${serial}.json`), JSON.stringify({script, mode, ...emptyCapture}, null, 2));
        const cleanup = async () => {
            try {
                await cleanupScanOwners(root, 'after-assertions');
                if (unacquiredEmpty) for (const owner of owners) {
                    const line = owner.output.split('\n').find(value => value.includes('"timerCleared":true'));
                    if (!line) throw new Error('controlled live-empty actor exit receipt missing');
                    unacquiredEmpty.actorExits.push({pid: owner.child.pid, receipt: JSON.parse(line)});
                }
            } finally {expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('foreign fixture must survive');}
        };
        return {result, profiles, report, ownerStates, cleanup, emptyCapture, unacquiredEmpty, retainedMarkers: profiles.map(profile => existsSync(join(temp, profile, 'uncertain-owner')) ? readFileSync(join(temp, profile, 'uncertain-owner'), 'utf8') : null)};
    } finally {
        // Legacy non-scan callers have no explicit cleanup hook. Keep their
        // observed profiles, then stop only the parent's known actor handles.
        if (!mode.startsWith('scan-')) {
            try {await cleanupScanOwners(root, 'legacy-port-finally');}
            finally {expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('foreign fixture must survive');}
        }
    }
}

describe('audit49 J continuation2 public consumer lifecycle', () => {
    for (const script of ['scripts/run-rich-text-input-editors-test.cjs', 'scripts/testing/run-free-routing-browser-test.cjs', 'scripts/testing/run-service-configuration-ui-test.cjs', 'scripts/testing/run-settings-center-ui-test.cjs', 'scripts/testing/run-popup-actions-service-ui-test.cjs', 'scripts/testing/run-startup-performance.cjs']) {
        for (const mode of ['report', 'report-close']) it(`${script}: ${mode} cannot bypass owned cleanup`, async () => {
            const {result, profiles} = await portCLI(script, mode);
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('REPORT_WRITE_FAILED');
            expect(result.stdout).toContain('SESSION_CLOSE');
            if (script.includes('free-routing') || script.includes('popup-actions') || script.includes('startup-performance')) expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
            expect(result.code).toBe(1);
            expect(profiles).toHaveLength(mode === 'report' ? 0 : 1);
        }, 20000);
    }
    for (const mode of ['worker-race', 'worker-event', 'worker-timeout']) it(`video settings ${mode} releases its worker listener`, async () => {
        const {result} = await portCLI('scripts/run-video-subtitle-settings-test.cjs', mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        const final = /WORKER_FINAL (.+)/.exec(result.stdout);
        expect(final).not.toBeNull();
        expect(JSON.parse(final![1]).listeners).toBe(0);
        if (mode !== 'worker-timeout') {
            expect(result.stdout).toContain('PUBLIC_AFTER_WORKER');
            expect(JSON.parse(final![1]).checks).toBe(1);
        }
    }, 20000);
    for (const mode of ['ready', 'ready-close']) it(`userscript ${mode}: WebKit is owned before newContext`, async () => {
        const {result, profiles} = await portCLI('scripts/run-userscript-smoke-test.cjs', mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('WEBKIT_LAUNCHED');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(mode === 'ready' ? 0 : 1);
    }, 20000);
    it('popup finalization joins a late focus observation and closes its session once', async () => {
        const {result, profiles, report} = await portCLI('scripts/testing/run-popup-actions-service-ui-test.cjs', 'focus');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('MONITOR_STARTED');
        expect(result.stdout).toContain('MONITOR_RESULT');
        expect(result.stdout.indexOf('SESSION_CLOSE')).toBeGreaterThan(result.stdout.indexOf('MONITOR_RESULT'));
        expect(result.stdout.match(/SESSION_CLOSE/g)).toHaveLength(1);
        expect(report?.focusMonitor.samples).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
    for (const mode of ['native-say', 'native-convert']) it(`audio GPU ${mode}: native child has TERM then KILL bound and cleanup`, async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', mode, ['--native-timeout-ms', '250']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_PORT_REACHED');
        expect(result.stdout + result.stderr).toContain('NATIVE_CHILD_LOADED');
        expect(result.stdout + result.stderr).toContain('NATIVE_TERM_RECEIVED');
        expect(result.stdout + result.stderr).toContain('timed out');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});

async function rdpCLI(mode: 'wrong-id' | 'wrong-actor' | 'report') {
    const root = mkdtempSync(join(fixtureRoot, 'rdp-'));
    const artifacts = join(root, 'artifacts');mkdirSync(artifacts);
    const remote = join(workspaceRoot, 'node_modules/.pnpm/web-ext-run@0.2.4/node_modules/web-ext-run/lib/firefox/remote.js');
    const loader = join(root, 'loader.mjs');
    writeFileSync(loader, `import {pathToFileURL} from 'node:url';
export async function resolve(specifier,context,next){if(specifier.endsWith('/web-ext-run/lib/firefox/remote.js'))return next(${JSON.stringify(pathToFileURL(remote).href)},context);return next(specifier,context);}
export async function load(url,context,next){if(url===${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/run-firefox-config-persistence.mjs')).href)})console.log('ORIGINAL_CLI_LOADED');return next(url,context);}`);
    const preload = join(root, 'preload.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';import {RemoteFirefox} from ${JSON.stringify(pathToFileURL(remote).href)};
const original=RemoteFirefox.prototype.disconnect;RemoteFirefox.prototype.disconnect=function(...args){console.log('RDP_DISCONNECT_REQUESTED');return original.apply(this,args);};
const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(${JSON.stringify(mode)}==='report'&&path.basename(file)==='firefox-config-persistence.json')throw new Error('controlled report write failure');return write.call(this,file,...args);};`);
    const packets: unknown[] = [];const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
        sockets.add(socket);socket.once('close', () => sockets.delete(socket));let pending = Buffer.alloc(0), location = 'about:blank', sequence = 0;
        const send = (packet: unknown) => {const data = Buffer.from(JSON.stringify(packet));socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));};
        send({from: 'root', applicationType: 'browser'});
        socket.on('data', chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (true) {
                const colon = pending.indexOf(58);if (colon < 0) break;const length = Number(pending.subarray(0, colon).toString());if (pending.length < colon + 1 + length) break;
                const message = JSON.parse(pending.subarray(colon + 1, colon + 1 + length).toString());pending = pending.subarray(colon + 1 + length);packets.push(message);
                if (message.type === 'listTabs') send({from: 'root', tabs: [{actor: 'tab', selected: true}]});
                else if (message.type === 'getTarget') send({from: 'tab', frame: {actor: 'frame', consoleActor: 'console', url: location}});
                else if (message.type === 'listAddons') send({from: 'root', addons: [{id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}', temporarilyInstalled: true, manifestURL: 'moz-extension://fixture/manifest.json'}]});
                else if (message.type === 'navigateTo') {
                    if (message.url.endsWith('options.html')) send({from: 'frame', error: 'fixture-end', message: 'controlled after popup'});
                    else {location = message.url;send({from: 'frame'});}
                } else if (message.type === 'evaluateJSAsync') {
                    const id = `evaluation-${++sequence}`;
                    const responses: unknown[] = [{from: 'console', resultID: id}, {from: 'console', type: 'evaluationResult', resultID: id, result: {value: JSON.stringify({correlated: true})}}];
                    if (mode !== 'report') responses.push({from: mode === 'wrong-actor' ? 'other-console' : 'console', type: 'evaluationResult', resultID: mode === 'wrong-id' ? `stale-${sequence}` : id, result: {value: JSON.stringify({correlated: false})}});
                    socket.write(Buffer.concat(responses.map(packet => {const data = Buffer.from(JSON.stringify(packet));return Buffer.concat([Buffer.from(`${data.length}:`), data]);})));
                } else send({from: message.to, error: 'unknown-fixture-request', message: message.type});
            }
        });
    });
    await new Promise<void>((resolveServer, reject) => {server.once('error', reject);server.listen(0, '127.0.0.1', resolveServer);});
    try {
        const address = server.address() as import('node:net').AddressInfo;
        const result = await child(['--loader', loader, '--import', preload, join(sourceRoot, 'scripts/run-firefox-config-persistence.mjs'), '--port', String(address.port), '--artifacts-dir', artifacts], {});
        const file = join(artifacts, 'firefox-config-persistence.json');
        const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        if (evidenceRoot) writeFileSync(join(evidenceRoot, `rdp-${serial}.json`), JSON.stringify({mode, packets, report}, null, 2));
        return {result, report};
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolveServer => server.close(() => resolveServer()));
    }
}

describe('audit49 J continuation2 actual RDP client and public CLI', () => {
    for (const mode of ['wrong-id', 'wrong-actor'] as const) it(`${mode}: pre-ack packets remain evaluation-owned`, async () => {
        const {result, report} = await rdpCLI(mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('RDP_DISCONNECT_REQUESTED');
        expect(report?.popup.correlated).toBe(true);
        expect(result.stderr).toContain('controlled after popup');
    }, 20000);
    it('Firefox report-write failure still disconnects its actual RDP client', async () => {
        const {result} = await rdpCLI('report');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('RDP_DISCONNECT_REQUESTED');
        expect(result.stderr).toContain('controlled report write failure');
    }, 20000);
});


describe('audit49 J continuation2 public stats callback and native error paths', () => {
    it.each([
        ['scripts/testing/run-translation-stats-ui-test.cjs', '本专项仅使用 macOS'],
        ['scripts/run-ai-context-ui-test.cjs', 'This suite requires the macOS'],
    ])('%s rejects an unsupported OS before acquiring browser/server/profile resources', async (script, reason) => {
        const observation = await portCLI(script, 'platform-block');
        try {
            const {result, profiles, ownerStates} = observation;
            expect(result.stdout).toContain(`CONTROLLED_MACOS_PLATFORM_PORT ${JSON.stringify({hostPlatform: process.platform, consumerPlatform: 'unsupported-fixture-platform'})}`);
            expect(result.stderr).toContain(reason);
            expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stdout).not.toContain('PUBLIC_IDB_SEED_CALLBACK');
            expect(result.stdout).not.toContain('OWNED_HTTP_SERVER_CLOSED');
            expect(result.code).toBe(1);
            expect(result.timedOut).toBe(false);
            expect(profiles).toEqual([]);
            expect(ownerStates).toEqual([]);
        } finally {await observation.cleanup();}
    }, 20000);
    for (const mode of ['idb-seed', 'idb-paging']) it(`${mode}: abort after successful puts rejects and releases the public consumer`, async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-translation-stats-ui-test.cjs', mode);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain(`CONTROLLED_MACOS_PLATFORM_PORT ${JSON.stringify({hostPlatform: process.platform, consumerPlatform: 'darwin'})}`);
        expect(result.stdout).toContain('PUBLIC_IDB_SEED_CALLBACK');
        expect(result.stdout).toContain('IDB_ABORT_ONLY');
        expect(result.stdout).not.toContain('IDB_TX_ERROR');
        expect(result.timedOut).toBe(false);
        const abort = JSON.parse(/IDB_ABORT_ONLY (.+)/.exec(result.stdout)![1]);
        expect(abort.completed).toBe(abort.issued);
        expect(abort.requestErrors).toBe(0);
        expect(abort.issued).toBe(mode === 'idb-seed' ? 10 : 53);
        expect(result.stdout).toContain('IDB_CLOSE');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.stderr).toContain('transaction aborted');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
    it('audio GPU failed native spawn waits for close and releases unlaunched fixture/profile', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', 'native-spawn-error', ['--native-timeout-ms', '250']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_PORT_REACHED');
        expect(result.stderr).toContain('ENOENT');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});


describe('audit49 J continuation2 native cancellation ownership', () => {
    it('audio GPU interruption kills and waits for its TERM-ignoring owned child before cleanup', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', 'native-cancel', ['--native-timeout-ms', '10000']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_CHILD_LOADED');
        expect(result.stdout).toContain('NATIVE_TERM_RECEIVED');
        expect(result.stderr).toContain('interrupted');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});


describe('audit49 J continuation2 preserved worker scan order', () => {
    it('video settings stops at the first initially matching worker despite a faster later worker', async () => {
        const {result} = await portCLI('scripts/run-video-subtitle-settings-test.cjs', 'worker-initial');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('SELECTED_WORKER_URL chrome-extension://fixture/options.html');
        const state = JSON.parse(/WORKER_FINAL (.+)/.exec(result.stdout)![1]);
        expect(state).toEqual({listeners: 0, checks: 1});
    }, 20000);
});

describe('audit49 J continuation2 startup server ownership', () => {
    it('startup performance closes its owned server but retains profile on browser close failure', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-startup-performance.cjs', 'ready-close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.stderr).toContain('controlled close failure');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    }, 20000);
});


// Final manual-candidate scan: one parameterized case per distinct public CLI.
// All modes execute before assertions, so the raw captures each ownership path.
const continuation3Scripts = [
    "scripts/testing/run-settings-center-ui-test.cjs",
    "scripts/testing/run-translation-responsiveness.cjs",
    "scripts/run-ai-context-ui-test.cjs",
    "scripts/run-cache-settings-test.cjs",
    "scripts/run-glossary-test.cjs",
    "scripts/run-input-translation-test.cjs",
    "scripts/run-privacy-boundary-test.cjs",
    "scripts/run-reading-progress-test.cjs",
    "scripts/run-selection-unified-test.cjs",
    "scripts/run-site-adaptation-test.cjs",
    "scripts/run-site-translation-test.cjs",
    "scripts/run-video-caption-prefetch-test.cjs",
    "scripts/run-video-performance-test.cjs",
    "scripts/run-vocabulary-study-test.cjs",
    "scripts/run-x-native-subtitle-test.cjs",
    "scripts/run-x-subtitle-sync-test.cjs",
    "scripts/run-youtube-subtitle-sync-test.cjs",
    "scripts/testing/run-bilingual-attribute-drift-test.cjs",
    "scripts/testing/run-changing-source-test.cjs",
    "scripts/testing/run-chrome-translation-ui-test.cjs",
    "scripts/testing/run-codeforces-translation-test.cjs",
    "scripts/testing/run-custom-base-url-ui-test.cjs",
    "scripts/testing/run-drive-version-compat-ui-test.cjs",
    "scripts/testing/run-github-release-test.cjs",
    "scripts/testing/run-github-task-list-test.cjs",
    "scripts/testing/run-google-drive-sync-ui-test.cjs",
    "scripts/testing/run-lazy-options-ui-test.cjs",
    "scripts/testing/run-manga-rendering-benchmark.cjs",
    "scripts/testing/run-modal-first-translation-test.cjs",
    "scripts/testing/run-multilingual-layout-ui-test.cjs",
    "scripts/testing/run-ocr-performance-test.cjs",
    "scripts/testing/run-ort-runtime-smoke.cjs",
    "scripts/testing/run-popup-onboarding-performance-test.cjs",
    "scripts/testing/run-popup-quick-settings-ui-test.cjs",
    "scripts/testing/run-reading-style-refresh-test.cjs",
    "scripts/testing/run-reported-fixes-test.cjs",
    "scripts/testing/run-select-ui-test.cjs",
    "scripts/testing/run-sentence-listening-test.cjs",
    "scripts/testing/run-service-library-ui-test.cjs",
    "scripts/testing/run-settings-hierarchy-ui-test.cjs",
    "scripts/testing/run-settings-reading-menu-ui-test.cjs",
    "scripts/testing/run-settings-viewport-ui-test.cjs",
    "scripts/testing/run-site-rules-ui-test.cjs",
    "scripts/testing/run-toolbar-status-test.cjs",
    "scripts/testing/run-translation-mutation-test.cjs",
    "scripts/testing/run-translation-viewport-test.cjs",
    "scripts/testing/run-ui-style-audit.cjs",
    "scripts/testing/run-webdav-backup-ui-test.cjs"
];
const continuation3ServerScripts = new Set([
    "scripts/testing/run-translation-responsiveness.cjs",
    "scripts/run-ai-context-ui-test.cjs",
    "scripts/run-glossary-test.cjs",
    "scripts/run-privacy-boundary-test.cjs",
    "scripts/run-reading-progress-test.cjs",
    "scripts/run-selection-unified-test.cjs",
    "scripts/run-vocabulary-study-test.cjs",
    "scripts/testing/run-bilingual-attribute-drift-test.cjs",
    "scripts/testing/run-changing-source-test.cjs",
    "scripts/testing/run-custom-base-url-ui-test.cjs",
    "scripts/testing/run-modal-first-translation-test.cjs",
    "scripts/testing/run-reading-style-refresh-test.cjs",
    "scripts/testing/run-sentence-listening-test.cjs",
    "scripts/testing/run-site-rules-ui-test.cjs",
    "scripts/testing/run-webdav-backup-ui-test.cjs"
]);

describe('audit49 J continuation3 complete manual cleanup consumers', () => {
    it.each(['scripts/run-reading-progress-test.cjs', 'scripts/testing/run-modal-first-translation-test.cjs'])('%s releases the first fixture when the second server fails before browser launch', async script => {
        const observation = await portCLI(script, 'scan-server-startup');
        try {
            expect(observation.result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(observation.result.stderr).toContain('controlled second fixture server bind failure');
            expect(observation.result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
            expect(observation.result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
            expect(observation.result.timedOut).toBe(false);
            expect(observation.result.code).toBe(1);
            expect(observation.profiles).toEqual([]);
            expect(observation.ownerStates).toEqual([]);
        } finally {await observation.cleanup();}
    }, 20000);
    for (const script of continuation3Scripts) it(`${script}: independent cleanup and uncertain profile ownership`, async () => {
        const modes = ['scan-report', 'scan-report-close', 'scan-partial'];
        const observations = [];
        try {
          for (const mode of modes) observations.push({mode, ...await portCLI(script, mode)});
          for (const observation of observations) {
            const {mode, result, profiles, retainedMarkers} = observation;
            expect(result.stdout, `${script} ${mode} original load`).toContain('ORIGINAL_CLI_LOADED');
            if (script === 'scripts/run-ai-context-ui-test.cjs') {
                expect(result.stdout).toContain(`CONTROLLED_MACOS_PLATFORM_PORT ${JSON.stringify({hostPlatform: process.platform, consumerPlatform: 'darwin'})}`);
            }
            if (script === 'scripts/run-site-translation-test.cjs') {
                expect(result.stdout).toContain(`CONTROLLED_SITE_PLATFORM_PORT ${JSON.stringify({hostPlatform: process.platform, consumerPlatform: 'darwin'})}`);
            }
            expect(result.stdout, `${script} ${mode} acquired external port`).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.timedOut, `${script} ${mode} finite consumer`).toBe(false);
            if (mode !== 'scan-partial') expect(result.stdout, `${script} ${mode} closes acquired browser\n${result.stderr}`).toContain('SESSION_CLOSE');
            if (continuation3ServerScripts.has(script)) expect(result.stdout, `${script} ${mode} releases independent HTTP fixture`).toContain('OWNED_HTTP_SERVER_CLOSED');
            if (mode === 'scan-report') expect(profiles, `${script} confirmed closed profile`).toEqual([]);
            else if (mode === 'scan-partial') expect(retainedMarkers, `${script} unknown active profile retained`).toContain('controlled active profile');
            else expect(profiles.length, `${script} rejected close profile retained`).toBeGreaterThan(0);
            expect(observation.ownerStates, `${script} ${mode} actual owned Node process`).toHaveLength(1);
            if (mode === 'scan-report') expect(observation.ownerStates[0]).toMatchObject({gone: true, timerCleared: true, fdClosed: true});
            else if (mode === 'scan-report-close') expect(observation.ownerStates[0]).toMatchObject({gone: true, profileExists: true, timerCleared: true, fdClosed: true});
            else expect(observation.ownerStates[0]).toMatchObject({gone: false, profileExists: true});
            if (script === 'scripts/testing/run-changing-source-test.cjs' || script === 'scripts/run-site-translation-test.cjs') {
              for (const marker of ['FOCUS_OBSERVER_COMPILE_PORT', 'FOCUS_OBSERVER_ACQUIRED', 'FOCUS_OBSERVER_READY', 'FOCUS_OBSERVER_STOP_REQUESTED', 'FOCUS_OBSERVER_CLOSED', 'FOCUS_OBSERVER_CLEANUP']) {
                expect(result.stdout.split(marker), `${script} ${mode} ${marker} once`).toHaveLength(2);
              }
              expect(result.stdout + result.stderr).not.toContain('controlled focus observer cleanup before close');
            }
          }
        } finally {
            for (const observation of observations) await observation.cleanup();
        }
    }, 60000);
    it('site translation refuses an unsupported platform before acquiring an observer or browser', async () => {
        const observation = await portCLI('scripts/run-site-translation-test.cjs', 'scan-site-platform-block');
        try {
            const {result} = observation;
            expect(result.stdout).toContain(`CONTROLLED_SITE_PLATFORM_PORT ${JSON.stringify({hostPlatform: process.platform, consumerPlatform: 'unsupported-fixture-platform'})}`);
            expect(result.stdout).not.toContain('FOCUS_OBSERVER_COMPILE_PORT');
            expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stderr).toContain('后台焦点事件监控目前只支持 macOS');
            expect(result.timedOut).toBe(false);
            expect(result.code).toBe(86);
            expect(observation.ownerStates).toEqual([]);
            expect(observation.profiles).toEqual([]);
        } finally {await observation.cleanup();}
    }, 20000);
    it('site translation stops before browser launch when its focus observer cannot start', async () => {
        const observation = await portCLI('scripts/run-site-translation-test.cjs', 'scan-focus-ready-failure');
        try {
            const {result} = observation;
            expect(result.stdout).toContain('FOCUS_OBSERVER_COMPILE_PORT');
            expect(result.stdout).toContain('FOCUS_OBSERVER_CLEANUP');
            expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stderr).toContain('controlled focus compile failure');
            expect(result.timedOut).toBe(false);
            expect(result.code).toBe(86);
            expect(observation.ownerStates).toEqual([]);
            expect(observation.profiles).toEqual([]);
        } finally {await observation.cleanup();}
    }, 20000);
    it('changing-source focus readiness failure releases both fixtures without launching a browser actor', async () => {
        const observation = await portCLI('scripts/testing/run-changing-source-test.cjs', 'scan-focus-ready-failure');
        try {
            const {result} = observation;
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout + result.stderr).toContain('controlled focus compile failure');
            expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stdout.split('FOCUS_OBSERVER_COMPILE_PORT')).toHaveLength(2);
            expect(result.stdout.split('FOCUS_OBSERVER_CLEANUP')).toHaveLength(2);
            for (const marker of ['FOCUS_OBSERVER_ACQUIRED', 'FOCUS_OBSERVER_READY', 'FOCUS_OBSERVER_STOP_REQUESTED', 'FOCUS_OBSERVER_CLOSED']) expect(result.stdout).not.toContain(marker);
            expect(result.stdout.split('OWNED_HTTP_SERVER_CLOSED')).toHaveLength(3);
            expect(result.stdout + result.stderr).not.toMatch(/TypeError|not a function|controlled focus observer cleanup before close/);
            expect(result.timedOut).toBe(false);
            expect(result.code).toBe(1);
            expect(observation.profiles).toEqual([]);
            expect(observation.ownerStates).toEqual([]);
        } finally {await observation.cleanup();}
    }, 20000);
});


describe('audit49 J acquired empty profile capture failure retention', () => {
    it.each([
        'scripts/run-input-translation-test.cjs',
        'scripts/testing/run-translation-responsiveness.cjs',
    ])('%s retains an acquired empty profile when CDP capture fails after native close succeeds', async script => {
        const observation = await portCLI(script, 'scan-capture-query-empty');
        try {
            const {result, profiles, report, ownerStates, emptyCapture} = observation;
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.timedOut).toBe(false);
            expect(result.signal).toBeNull();
            expect(result.code).toBe(1);
            expect(ownerStates).toHaveLength(1);
            const owner = ownerStates[0];
            expect(Number.isSafeInteger(owner.pid)).toBe(true);
            expect(owner.pid).toBeGreaterThan(0);
            expect(owner).toMatchObject({gone: true, profileExists: true, timerCleared: true, fdClosed: true});

            const ready = 'OWNED_NODE_READY ' + owner.pid;
            const query = 'OWNED_NODE_CDP_QUERY_THROW ' + owner.pid;
            const detached = 'OWNED_NODE_CDP_DETACHED ' + owner.pid;
            const closed = 'OWNED_NODE_CLOSE_CONFIRMED ' + owner.pid;
            for (const marker of [ready, query, detached, 'SESSION_CLOSE', closed]) {
                expect(result.stdout.split(marker)).toHaveLength(2);
            }
            expect(result.stdout.indexOf(query)).toBeGreaterThan(result.stdout.indexOf(ready));
            expect(result.stdout.indexOf(detached)).toBeGreaterThan(result.stdout.indexOf(query));
            expect(result.stdout.indexOf('SESSION_CLOSE')).toBeGreaterThan(result.stdout.indexOf(detached));
            expect(result.stdout.indexOf(closed)).toBeGreaterThan(result.stdout.indexOf('SESSION_CLOSE'));
            expect(result.stdout).not.toContain('OWNED_NODE_CDP_PID');
            expect(result.stderr).toContain('controlled readiness failure');
            expect(result.stderr).toContain('controlled acquired-empty CDP query failure');

            expect(emptyCapture).not.toBeNull();
            const capture = emptyCapture!;
            expect(capture.receipts).toHaveLength(3);
            const started = capture.receipts.find(receipt => receipt.reason === 'actual-parent-owned-start');
            const stopped = capture.receipts.find(receipt => receipt.reason === 'awaited-launcher-close');
            const confirmed = capture.receipts.find(receipt => receipt.reason === 'empty-profile-launcher-close-confirmed');
            expect(started).toMatchObject({
                pid: owner.pid, profile: owner.profile, ready: true, psNative: true,
                actorReady: {ready: true, pid: owner.pid, fdOpen: true, timerReferenced: true},
                profileEntries: ['fixture-owner.lock'],
            });
            expect(started?.psRow).toContain('--user-data-dir=' + owner.profile);
            expect(started?.startIdentity).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
            expect(started?.actorArgs).toContain('--remove-owned-lock-on-exit');
            expect(stopped).toMatchObject({
                pid: owner.pid, profile: owner.profile, signals: ['SIGTERM'],
                waited: true, gone: true, timerCleared: true, fdClosed: true,
                profileExists: true, code: 0, signal: null,
            });
            expect(confirmed).toMatchObject({
                pid: owner.pid, profile: owner.profile, psNative: true,
                absent: {code: 1, stdout: '', stderr: ''},
                actorExit: {timerCleared: true, fdClosed: true, fdCloseCode: 'EBADF', lockRemoved: true},
                profileEntries: [], code: 0, signal: null,
            });

            // A fulfilled original launcher close is insufficient after failed
            // capture. The public caller has a session and must retain even an
            // empty directory, rather than using its unacquired-profile branch.
            expect(report?.cleanupErrors).toHaveLength(1);
            expect(JSON.stringify(report?.cleanupErrors)).toContain('controlled acquired-empty CDP query failure');
            expect(report?.fatal || report?.failure).toContain('controlled readiness failure');
            expect(profiles).toHaveLength(1);
            expect(owner.profile.endsWith('/' + profiles[0])).toBe(true);
            expect(capture.profiles).toEqual([{profile: owner.profile, exists: true, entries: []}]);
            expect(existsSync(owner.profile)).toBe(true);
            expect(readdirSync(owner.profile)).toEqual([]);
            expect(capture.foreignSentinel).toBe('foreign fixture must survive');
            if (script === 'scripts/run-input-translation-test.cjs') expect(report?.completed).toBe(false);
            else {
                expect(report?.ok).toBe(false);
                expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
            }
        } finally {await observation.cleanup();}
    }, 20000);
});


// Additive P2 regression: enter the unchanged public measurement body and fail
// a declared external CDP operation. All existing audit49J assertions stay intact.
describe('audit49 J video public body failure and scoped cleanup', () => {
    it.each(['scan-video-body', 'scan-video-body-close'] as const)('%s preserves the public metrics error and cleanup ownership', async mode => {
        const observation = await portCLI('scripts/run-video-performance-test.cjs', mode);
        try {
            const {result, profiles, ownerStates} = observation;
            expect(result.timedOut).toBe(false);
            expect(result.code).toBe(1);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stdout).toContain('OWNED_NODE_CDP_PID');
            expect(result.stdout).toContain('VIDEO_CDP_CLIENT_ACQUIRED');
            expect(result.stdout).toContain('VIDEO_PERFORMANCE_ENABLED');
            expect(result.stdout).toContain('VIDEO_PUBLIC_GOTO');
            expect(result.stdout).toContain('VIDEO_PUBLIC_WAIT 5000');
            expect(result.stdout).toContain('VIDEO_PUBLIC_BODY_FAILURE Performance.getMetrics');
            expect(result.stdout.match(/VIDEO_CDP_DETACH/g)).toHaveLength(1);
            expect(result.stdout.match(/SESSION_CLOSE/g)).toHaveLength(1);
            expect(result.stdout.indexOf('VIDEO_CDP_DETACH')).toBeLessThan(result.stdout.indexOf('SESSION_CLOSE'));
            expect(result.stderr).toContain('controlled video metrics failure');
            expect(result.stderr).not.toMatch(/ReferenceError|TypeError|not defined|not a function|undefined/);
            expect(ownerStates).toHaveLength(1);
            expect(ownerStates[0]).toMatchObject({gone: true, timerCleared: true, fdClosed: true});
            if (mode === 'scan-video-body-close') {
                const cleanupErrors = result.stderr.split('\n').filter(line => line.startsWith('Cleanup failed:'));
                expect(cleanupErrors).toHaveLength(2);
                expect(cleanupErrors[0]).toContain('controlled video detach failure');
                expect(cleanupErrors[1]).toContain('controlled close failure');
                expect(result.stderr.indexOf('controlled video metrics failure')).toBeGreaterThan(result.stderr.indexOf('controlled close failure'));
                expect(profiles).toHaveLength(1);
                expect(ownerStates[0]).toMatchObject({profileExists: true});
            } else {
                expect(result.stderr).not.toContain('Cleanup failed:');
                expect(profiles).toEqual([]);
                expect(ownerStates[0]).toMatchObject({profileExists: false});
            }
        } finally {await observation.cleanup();}
    }, 20000);
});


// A launcher can start an owned process and reject before returning its session.
// The actor unlinks its own file while keeping the real FD and timer alive;
// the unchanged public caller must retain that genuinely empty profile.
describe('audit49 J unacquired empty profile partial launch retention', () => {
    it.each([
        'scripts/run-input-translation-test.cjs',
        'scripts/run-video-performance-test.cjs',
    ])('%s retains an empty profile when its launcher rejects with an actor still alive', async script => {
        const observation = await portCLI(script, 'scan-partial-empty');
        try {
            const {result, profiles, ownerStates, unacquiredEmpty} = observation;
            expect(result.timedOut).toBe(false);
            expect(result.signal).toBeNull();
            expect(result.code).toBe(1);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stderr).toContain('controlled live-empty partial launch failure');
            expect(result.stderr).not.toMatch(/ReferenceError|TypeError|not defined|not a function|undefined|Cleanup failed/);
            expect(result.stdout).not.toContain('SESSION_CLOSE');
            expect(result.stdout).not.toContain('OWNED_NODE_CDP_PID');
            expect(result.stdout).not.toContain('OWNED_NODE_CLOSE_CONFIRMED');
            expect(ownerStates).toHaveLength(1);
            const owner = ownerStates[0];
            expect(Number.isSafeInteger(owner.pid)).toBe(true);
            expect(owner.pid).toBeGreaterThan(0);
            expect(owner).toMatchObject({gone: false, profileExists: true, timerCleared: false, fdClosed: false});
            const ready = 'OWNED_NODE_READY ' + owner.pid;
            const rejected = 'PARTIAL_EMPTY_LAUNCH_REJECTED ' + owner.pid;
            for (const marker of [ready, rejected]) expect(result.stdout.split(marker)).toHaveLength(2);
            expect(result.stdout.indexOf(rejected)).toBeGreaterThan(result.stdout.indexOf(ready));

            expect(unacquiredEmpty).not.toBeNull();
            const capture = unacquiredEmpty!;
            expect(capture.receipts).toHaveLength(1);
            const started = capture.receipts[0];
            expect(started).toMatchObject({
                reason: 'actual-parent-owned-start', pid: owner.pid, profile: owner.profile,
                ready: true, psNative: true, profileEntries: [],
                actorReady: {ready: true, pid: owner.pid, fdOpen: true, timerReferenced: true, lockRemoved: true},
            });
            expect(started.actorArgs).toContain('--unlink-owned-lock-after-open');
            expect(started.psRow).toContain('--user-data-dir=' + owner.profile);
            expect(started.startIdentity).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
            expect(capture.nativeRows).toHaveLength(1);
            const live = capture.nativeRows[0];
            const row = live.stdout.trim().match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S[^\r\n]*)$/);
            expect(live.pid).toBe(owner.pid);
            expect(Number(row?.[1])).toBe(owner.pid);
            expect(row?.[2].replace(/\s+/g, ' ')).toBe(started.startIdentity);
            expect(row?.[3].split(/\s+/).filter(argument => argument === '--user-data-dir' || argument.startsWith('--user-data-dir='))).toEqual(['--user-data-dir=' + owner.profile]);
            expect(profiles).toHaveLength(1);
            expect(owner.profile.endsWith('/' + profiles[0])).toBe(true);
            expect(capture.profiles).toEqual([{profile: owner.profile, exists: true, entries: []}]);
            expect(existsSync(owner.profile)).toBe(true);
            expect(readdirSync(owner.profile)).toEqual([]);
            expect(capture.foreignSentinel).toBe('foreign fixture must survive');
        } finally {
            await observation.cleanup();
            // Only the parent's held handle is stopped after retention assertions.
            // Awaited exit still proves timer cleanup and closure of the unlinked FD.
            expect(observation.unacquiredEmpty?.actorExits).toHaveLength(1);
            expect(observation.unacquiredEmpty?.actorExits[0]).toMatchObject({
                pid: observation.ownerStates[0]?.pid,
                receipt: {timerCleared: true, fdClosed: true, fdCloseCode: 'EBADF', lockRemoved: true},
            });
            for (const owner of observation.ownerStates) {
                const receipts = scanProcessReceipts.filter(receipt => receipt.profile === owner.profile);
                expect(receipts).toHaveLength(2);
                expect(receipts[1]).toMatchObject({
                    reason: 'after-assertions', pid: owner.pid, profile: owner.profile,
                    signals: ['SIGTERM'], waited: true, gone: true, timerCleared: true, fdClosed: true,
                    profileExists: true, code: 0, signal: null,
                });
                const held = [...scanOwners.values()].flat().find(candidate => candidate.profile === owner.profile);
                expect(held).toBeUndefined();
                expect(existsSync(owner.profile)).toBe(true);
                expect(readdirSync(owner.profile)).toEqual([]);
            }
        }
    }, 20000);
});
