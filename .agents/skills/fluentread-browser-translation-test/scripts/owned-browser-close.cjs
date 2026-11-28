'use strict';

// Caller supplies its exact, freshly mkdtemp-created profile immediately after
// launch. Never discover browsers, read SingletonLock, or delete a profile here.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CDP_MS = 1500, DETACH_MS = 500, NATIVE_MS = 5000, PS_MS = 750;
const GRACE_MS = 250, TERM_MS = 750, KILL_MS = 1500, POLL_MS = 40;
const guardedSessions = new WeakMap();

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function throwFailures(errors) {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, `Browser close failed: ${String(errors[0])}; first error is primary`, {cause: errors[0]});
    }
}

async function bounded(action, milliseconds, code) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(action),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure(code, 'Browser close operation timed out')), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function profileIdentity(profile) {
    // ps command text does not preserve argv quoting. Reject profile spellings
    // that would make the one complete argument ambiguous, rather than guess.
    if (typeof profile !== 'string' || !path.isAbsolute(profile)
        || path.resolve(profile) !== profile || !/^[A-Za-z0-9_./-]+$/.test(profile)) {
        throw failure('PROFILE_INVALID', 'Expected an unambiguous absolute temporary profile');
    }
    const stat = fs.lstatSync(profile);
    const realPath = fs.realpathSync(profile);
    // Existing callers use both the per-user macOS TMPDIR and standard /tmp.
    // Canonicalize only these roots; never admit an arbitrary workspace root.
    const temporaryRoots = [...new Set([os.tmpdir(), '/private/tmp', '/tmp']
        .filter(root => fs.existsSync(root)).map(root => fs.realpathSync(root)))];
    if (!stat.isDirectory() || !temporaryRoots.some(root => realPath.startsWith(root + path.sep))) {
        throw failure('PROFILE_INVALID', 'Expected an existing temporary directory, without a final symlink');
    }
    return {profile, realPath, dev: stat.dev, ino: stat.ino};
}

async function processRow(pid, milliseconds) {
    return bounded(() => new Promise((resolve, reject) => {
        cp.execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'stat=', '-o', 'command='], {
            encoding: 'utf8', timeout: milliseconds, maxBuffer: 1024 * 1024,
            env: {...process.env, LC_ALL: 'C'},
        }, (error, output, stderr) => {
            // ps exits 1 with no rows for an absent selected PID. Permission,
            // timeout, truncated output and other failures are not absence.
            if (error) {
                if (error.code === 1 && output === '' && stderr === '') resolve(null);
                else reject(error);
            } else resolve(output);
        });
    }), milliseconds, 'PS_TIMEOUT');
}

async function processSnapshot(pid, milliseconds = PS_MS) {
    const stdout = await processRow(pid, milliseconds);
    if (stdout === null) return null;
    if (typeof stdout !== 'string') throw failure('PS_INVALID', 'Invalid process observation');
    const row = stdout.trim();
    const match = row.match(/^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([?A-Za-z][?A-Za-z+<>=-]*)\s+(\S[^\r\n]*)$/);
    if (!match || Number(match[1]) !== pid) throw failure('PS_INVALID', 'No exact PID/start/command observation');
    let start = match[2].replace(/\s+/g, ' ');
    if (process.platform === 'linux') {
        // Linux kernel ticks distinguish incarnations even within one second.
        let stat;
        try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
        catch (error) {
            // The observed actor can be reaped between ps and /proc. ENOENT
            // alone is not absence: require a fresh, bounded ps no-row result.
            // A live/reused PID, denied read or failed query still rejects.
            if (error.code === 'ENOENT' && await processRow(pid, milliseconds) === null) return null;
            throw error;
        }
        const boundary = stat.lastIndexOf(') ');
        const ticks = stat.slice(boundary + 2).split(' ')[19];
        if (boundary < 0 || !stat.startsWith(`${pid} (`) || !/^\d+$/.test(ticks)) {
            throw failure('PS_INVALID', 'Invalid kernel process start identity');
        }
        start += `:${ticks}`;
    } else if (process.platform !== 'darwin') {
        throw failure('PLATFORM_UNSUPPORTED', 'No supported process start identity');
    }
    return {start, command: match[4], exiting: match[3].startsWith('Z') || match[3].includes('E')};
}

function assertProfileArgument(command, profile) {
    const argumentsWithProfile = command.split(/\s+/).filter(argument =>
        argument === '--user-data-dir' || argument.startsWith('--user-data-dir='));
    if (/["'\\]/.test(command) || argumentsWithProfile.length !== 1
        || argumentsWithProfile[0] !== `--user-data-dir=${profile}`) {
        throw failure('OWNERSHIP_UNKNOWN', 'Process does not have one exact, unambiguous profile argument');
    }
}

async function captureOwnership(session, profile) {
    const errors = [];
    let cdp, expired = false, owner;
    // This promise also handles a CDP session created after the connect timeout.
    const connecting = Promise.resolve().then(() => session.context.browser().newBrowserCDPSession());
    connecting.then(value => {
        if (expired) void bounded(() => value.detach(), DETACH_MS, 'DETACH_TIMEOUT').catch(() => {});
    }, () => {});
    try {
        cdp = await bounded(() => connecting, CDP_MS, 'CDP_CONNECT_TIMEOUT');
        const directory = profileIdentity(profile);
        const result = await bounded(() => cdp.send('SystemInfo.getProcessInfo'), CDP_MS, 'CDP_QUERY_TIMEOUT');
        const browsers = Array.isArray(result?.processInfo)
            ? result.processInfo.filter(info => info?.type === 'browser') : [];
        if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0].id)
            || browsers[0].id <= 0 || browsers[0].id === process.pid) {
            throw failure('OWNERSHIP_UNKNOWN', 'CDP did not supply one exact positive browser PID');
        }
        const pid = browsers[0].id;
        const snapshot = await processSnapshot(pid);
        if (!snapshot) throw failure('OWNERSHIP_UNKNOWN', 'Browser disappeared before ownership capture');
        assertProfileArgument(snapshot.command, profile);
        owner = {...directory, pid, ...snapshot};
    } catch (error) {
        errors.push(error);
    } finally {
        expired = true;
        if (cdp) {
            try { await bounded(() => cdp.detach(), DETACH_MS, 'DETACH_TIMEOUT'); }
            catch (error) { errors.push(error); }
        }
    }
    // Do not leak a rejection before the caller is ready to close its session.
    return {owner, errors};
}

async function observeOwner(owner, milliseconds) {
    const directory = profileIdentity(owner.profile);
    if (directory.realPath !== owner.realPath || directory.dev !== owner.dev || directory.ino !== owner.ino) {
        throw failure('IDENTITY_CHANGED', 'Temporary profile directory identity changed');
    }
    const snapshot = await processSnapshot(owner.pid, milliseconds);
    if (!snapshot) return false;
    if (snapshot.start !== owner.start) {
        throw failure('IDENTITY_CHANGED', 'Browser process identity changed; refusing a signal or receipt');
    }
    if (!snapshot.exiting && snapshot.command !== owner.command) {
        // Darwin ps can sample the original start and R state but lose argv
        // during exit, returning only "(node)" or another comm placeholder.
        // This is not ownership or absence: permit bounded observation only.
        if (process.platform === 'darwin' && /^\([^()\r\n]+\)$/.test(snapshot.command)) {
            return {...snapshot, commandUnavailable: true};
        }
        throw failure('IDENTITY_CHANGED', 'Browser process identity changed; refusing a signal or receipt');
    }
    // An exited process may temporarily expose "(node)" rather than its argv.
    // It still occupies the PID: wait for reaping, without signalling it or
    // treating its terminal state as a deletion receipt.
    return snapshot;
}

async function waitGone(owner, milliseconds) {
    const deadline = performance.now() + milliseconds;
    for (;;) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        // Do not shrink a process query to the final few milliseconds of the
        // grace period. Each query keeps its own bound; expiry is checked
        // between observations, so a normal ps startup cannot fake a failure.
        if (!await observeOwner(owner, PS_MS)) return true;
        await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - performance.now()))));
    }
}

async function terminateOwned(owner) {
    if (await waitGone(owner, GRACE_MS)) return;
    for (const [signal, wait] of [['SIGTERM', TERM_MS], ['SIGKILL', KILL_MS]]) {
        // A fresh exact-PID/start/profile observation precedes every signal.
        const current = await observeOwner(owner, PS_MS);
        if (!current) return;
        if (current.exiting || current.commandUnavailable) {
            if (await waitGone(owner, wait)) return;
            if (current.commandUnavailable) {
                throw failure('IDENTITY_CHANGED', 'Browser command identity remained unavailable; retain its profile');
            }
            throw failure('TERMINATION_TIMEOUT', 'Exited browser has not been reaped; retain its profile');
        }
        try { process.kill(owner.pid, signal); }
        catch (error) {
            if (error.code !== 'ESRCH') throw error;
            // ESRCH alone is not a termination receipt; query ps again.
        }
        if (await waitGone(owner, wait)) return;
    }
    throw failure('TERMINATION_TIMEOUT', 'Owned browser did not disappear; retain its profile');
}

/**
 * Wrap a launched plain session synchronously; invoke immediately after launch.
 * Only fulfilled guarded close is a browser-PID receipt. It never removes files.
 * Caller must retain profile and fixtures on rejection, including native errors.
 * macOS native CDP helpers provide transport-only close and guarded signal routing.
 * ps+kill cannot atomically exclude PID reuse between observation and signal.
 */
function guardBrowserClose(session, profile) {
    const existing = guardedSessions.get(session);
    if (existing) {
        if (existing.profile !== profile) throw failure('PROFILE_CHANGED', 'Session already belongs to another temporary profile');
        return session;
    }
    const nativeCdpMode = session.launchMode === 'macos-background-cdp' || session.launchMode === 'macos-foreground-cdp';
    const nativeClose = typeof session.closeBrowserConnection === 'function'
        ? session.closeBrowserConnection
        : nativeCdpMode ? undefined : session.close;
    const routeSignals = session.useGuardedClose;
    const portFailure = nativeCdpMode
        && (typeof nativeClose !== 'function' || typeof routeSignals !== 'function')
        ? failure('HELPER_UNSUPPORTED', 'Native CDP helper requires transport-only close and guarded signal routing')
        : undefined;
    const capture = captureOwnership(session, profile);
    let closing, routingError;
    session.close = () => {
        closing ||= (async () => {
            const captured = await capture;
            const errors = [];
            try {
                if (portFailure) throw portFailure;
                await bounded(() => nativeClose.call(session), NATIVE_MS, 'NATIVE_CLOSE_TIMEOUT');
            }
            catch (error) { errors.push(error); }
            if (routingError) errors.push(routingError);
            errors.push(...captured.errors);
            // Even native close rejection does not excuse leaving a known
            // owned actor running. Cleanup never turns that rejection into rm.
            if (captured.owner) {
                try { await terminateOwned(captured.owner); }
                catch (error) { errors.push(error); }
            }
            throwFailures(errors);
        })();
        return closing;
    };
    guardedSessions.set(session, {profile, capture});
    if (!portFailure && typeof routeSignals === 'function') {
        try { routeSignals.call(session, session.close); }
        catch (error) { routingError = error; }
    }
    return session;
}

/**
 * Read launch-time focus metadata from the existing ownership capture only.
 * Await the complete capture, including its bounded detach, and preserve every
 * capture error for both this reader and guarded close. This PID snapshot is
 * neither a live process observation nor a browser-gone receipt; only close may
 * revalidate identity and authorize OS termination. No new CDP session is opened.
 */
async function getGuardedBrowserPid(session) {
    const guarded = guardedSessions.get(session);
    if (!guarded) throw failure('SESSION_UNGUARDED', 'Session must be guarded before reading its browser PID');
    const captured = await guarded.capture;
    throwFailures(captured.errors);
    if (!captured.owner) throw failure('OWNERSHIP_UNKNOWN', 'Guard did not capture a verified browser owner');
    return captured.owner.pid;
}

module.exports = {guardBrowserClose, getGuardedBrowserPid};
