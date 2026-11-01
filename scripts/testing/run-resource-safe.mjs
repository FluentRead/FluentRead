#!/usr/bin/env node

import {mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_CPU_TARGET_PERCENT = 60;
export const DEFAULT_MAX_WORKERS = 2;
export const DEFAULT_LOCK_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 5;
const DEFAULT_RETRY_MS = 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;
const LOCK_ROOT = process.env.FLUENTREAD_RESOURCE_LOCK_DIR || path.join(os.tmpdir(), 'fluentread-test-resource');
// 全局锁是计数信号量：每个槽位是一个独立的原子目录锁。槽 0 沿用旧版唯一的
// lock 目录，尚未更新的 worktree 只认它，仍会与新版本在同一个槽位上互相协调。
const LEGACY_SLOT_NAME = 'lock';
let ownedToken;
let ownedSlotDir;

function slotDir(index) {
    return path.join(LOCK_ROOT, index === 0 ? LEGACY_SLOT_NAME : `${LEGACY_SLOT_NAME}-${index}`);
}

function ownerFile(directory) {
    return path.join(directory, 'owner.json');
}

// macOS does not provide a reliable portable percentage cap here; reserve capacity cooperatively.

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPercent(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 90 ? parsed : fallback;
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage() {
    console.log([
        '用法: node scripts/testing/run-resource-safe.mjs [options] -- <command> [args...]',
        '',
        `默认 CPU target: ${DEFAULT_CPU_TARGET_PERCENT}%`,
        `默认 Vitest maxWorkers: ${DEFAULT_MAX_WORKERS}`,
        `默认全局锁并发: ${DEFAULT_CONCURRENCY}`,
        '',
        '选项:',
        '  --cpu-target <10-90>  设置资源预算目标（通过全局锁和 worker 限制实现）',
        '  --max-workers <n>     传给子进程的 FLUENTREAD_TEST_MAX_WORKERS',
        `  --concurrency <n>     全局测试锁的并发槽位数（默认 ${DEFAULT_CONCURRENCY}，1 为完全串行）`,
        '  --wait-ms <n>         等待全局测试锁的最长时间',
        '  --help                显示帮助',
    ].join('\n'));
}

export function parseArgs(argv) {
    const separator = argv.indexOf('--');
    const optionArgs = separator === -1 ? argv : argv.slice(0, separator);
    const commandArgs = separator === -1 ? [] : argv.slice(separator + 1);
    // pnpm test -- <file> 的首个转发分隔符只对 Vitest CLI 多余；其他命令和
    // 参数内部的 -- 有自己的语义，不能统一删除。
    const forwardedSeparator = commandArgs.indexOf('--', 1);
    if (/^(?:vitest|vitest\.cmd)$/u.test(path.basename(commandArgs[0] ?? '')) && forwardedSeparator >= 0) {
        commandArgs.splice(forwardedSeparator, 1);
    }
    let cpuTargetPercent = boundedPercent(process.env.FLUENTREAD_TEST_CPU_TARGET, DEFAULT_CPU_TARGET_PERCENT);
    let maxWorkers = positiveInteger(process.env.FLUENTREAD_TEST_MAX_WORKERS, DEFAULT_MAX_WORKERS);
    let waitMs = positiveInteger(process.env.FLUENTREAD_TEST_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS);
    let concurrency = positiveInteger(process.env.FLUENTREAD_TEST_CONCURRENCY, DEFAULT_CONCURRENCY);

    for (let index = 0; index < optionArgs.length; index += 1) {
        const option = optionArgs[index];
        if (option === '--help') return {help: true};
        if (!option.startsWith('--')) throw new Error(`无法识别参数: ${option}`);
        const value = optionArgs[index + 1];
        if (value === undefined || value.startsWith('--')) throw new Error(`参数缺少值: ${option}`);
        if (option === '--cpu-target') cpuTargetPercent = boundedPercent(value, NaN);
        else if (option === '--max-workers') maxWorkers = positiveInteger(value, NaN);
        else if (option === '--wait-ms') waitMs = positiveInteger(value, NaN);
        else if (option === '--concurrency') concurrency = positiveInteger(value, NaN);
        else throw new Error(`无法识别参数: ${option}`);
        if (!Number.isFinite(cpuTargetPercent) && option === '--cpu-target') throw new Error('--cpu-target 必须是 10-90 的数字');
        if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error('--max-workers 必须是正整数');
        if (!Number.isInteger(waitMs) || waitMs < 1) throw new Error('--wait-ms 必须是正整数');
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency 必须是正整数');
        index += 1;
    }

    if (commandArgs.length === 0) throw new Error('必须在 -- 后提供要运行的命令');
    return {command: commandArgs[0], args: commandArgs.slice(1), cpuTargetPercent, maxWorkers, waitMs, concurrency};
}

export function createResourceOptions(command, args = []) {
    return {
        command,
        args,
        cpuTargetPercent: boundedPercent(process.env.FLUENTREAD_TEST_CPU_TARGET, DEFAULT_CPU_TARGET_PERCENT),
        maxWorkers: positiveInteger(process.env.FLUENTREAD_TEST_MAX_WORKERS, DEFAULT_MAX_WORKERS),
        waitMs: positiveInteger(process.env.FLUENTREAD_TEST_LOCK_WAIT_MS, DEFAULT_LOCK_WAIT_MS),
        concurrency: positiveInteger(process.env.FLUENTREAD_TEST_CONCURRENCY, DEFAULT_CONCURRENCY),
    };
}

async function readOwner(directory) {
    try {
        return JSON.parse(await readFile(ownerFile(directory), 'utf8'));
    } catch {
        return null;
    }
}

function processIsRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

async function removeStaleLock(lockDir) {
    // 先固定锁目录这一代的 inode，再读取 owner；二者都来自同一代时才可能判定为陈旧。
    let lockStat;
    try {
        lockStat = await stat(lockDir);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }
    const owner = await readOwner(lockDir);
    if (owner?.pid && processIsRunning(owner.pid)) return false;
    if (!owner && Date.now() - lockStat.mtimeMs < STALE_LOCK_MS) return false;
    // 多个等待者不能同时删除旧锁：在锁目录内部竞争一次清理权，随后重读
    // owner 和 inode，避免晚到的清理者误删另一个进程刚建立的新锁。
    const reaping = path.join(lockDir, 'reaping');
    try {
        await mkdir(reaping);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
    let reaped = false;
    try {
        const currentStat = await stat(lockDir);
        const currentOwner = await readOwner(lockDir);
        // owner 与首次读取不同，说明中途换代或新锁仍在写 owner，不能按陈旧锁回收。
        if (currentStat.ino !== lockStat.ino || currentStat.dev !== lockStat.dev ||
            JSON.stringify(currentOwner) !== JSON.stringify(owner) ||
            processIsRunning(currentOwner?.pid)) return false;
        // 原子改名让整代锁一次性消失；原地递归删除时 reaping 已删而目录仍在，
        // 其他等待者可再建 reaping，使 rmdir 以 ENOTEMPTY 失败并让等待进程崩溃。
        const tombstone = path.join(LOCK_ROOT, `reaped-${randomUUID()}`);
        await rename(lockDir, tombstone);
        reaped = true;
        await rm(tombstone, {recursive: true, force: true}).catch(() => undefined);
        return true;
    } finally {
        if (!reaped) {
            const currentStat = await stat(lockDir).catch(() => undefined);
            if (currentStat?.ino === lockStat.ino && currentStat.dev === lockStat.dev) {
                await rm(reaping, {recursive: true, force: true});
            }
        }
    }
}

/** 在单个槽位上原子建锁；槽位已被占用时返回 false，由调用方尝试下一个槽位。 */
async function tryAcquireSlot(lockDir, options) {
    // 陈旧槽位被回收后同一轮立即重试一次；仍被他人抢先则视为占用。
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDir);
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (await removeStaleLock(lockDir)) continue;
            return false;
        }
        const token = randomUUID();
        await writeFile(ownerFile(lockDir), JSON.stringify({
            pid: process.pid,
            token,
            cwd: process.cwd(),
            command: [options.command, ...options.args].join(' '),
            cpuTargetPercent: options.cpuTargetPercent,
            maxWorkers: options.maxWorkers,
            slot: path.basename(lockDir),
            concurrency: options.concurrency,
            startedAt: new Date().toISOString(),
        }, null, 2));
        ownedToken = token;
        ownedSlotDir = lockDir;
        return true;
    }
    return false;
}

export async function acquireLock(options) {
    await mkdir(LOCK_ROOT, {recursive: true});
    const concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
    const deadline = Date.now() + options.waitMs;
    let announcedWait = false;
    while (true) {
        for (let index = 0; index < concurrency; index += 1) {
            if (await tryAcquireSlot(slotDir(index), options)) return;
        }
        if (!announcedWait) {
            const owners = await Promise.all(Array.from({length: concurrency}, (_, index) => readOwner(slotDir(index))));
            const commands = owners.map(owner => owner?.command).filter(Boolean);
            console.error(`[resource-safe] 等待全局测试锁（${concurrency} 个并发槽已占满${commands.length ? `，当前: ${commands.join('; ')}` : ''}）`);
            announcedWait = true;
        }
        if (Date.now() >= deadline) throw new Error(`等待全局测试锁超过 ${options.waitMs}ms`);
        await delay(DEFAULT_RETRY_MS);
    }
}

export async function releaseLock() {
    if (!ownedSlotDir) return;
    const owner = await readOwner(ownedSlotDir);
    if (ownedToken && owner?.pid === process.pid && owner.token === ownedToken) {
        await rm(ownedSlotDir, {recursive: true, force: true});
        ownedToken = undefined;
        ownedSlotDir = undefined;
    }
}

/** 父进程通过环境变量传递所持槽位；缺失时回退旧版唯一槽位，兼容旧 runner 启动的子命令。 */
function inheritedSlotDir() {
    const name = process.env.FLUENTREAD_RESOURCE_LOCK_SLOT || LEGACY_SLOT_NAME;
    return /^lock(?:-[1-9]\d*)?$/u.test(name) ? path.join(LOCK_ROOT, name) : undefined;
}

export async function hasInheritedLock() {
    if (process.env.FLUENTREAD_RESOURCE_LOCK_HELD !== '1') return false;
    const lockDir = inheritedSlotDir();
    if (!lockDir) return false;
    const owner = await readOwner(lockDir);
    return Boolean(owner?.token && owner.token === process.env.FLUENTREAD_RESOURCE_LOCK_TOKEN &&
        processIsRunning(owner.pid));
}

function signalProcessGroup(child, signal) {
    if (!child?.pid) return;
    try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch {
        try {
            process.kill(child.pid, signal);
        } catch {
            // The child may have exited between the two signal attempts.
        }
    }
}

async function runChild(options) {
    const env = {
        ...process.env,
        FLUENTREAD_RESOURCE_LOCK_HELD: '1',
        FLUENTREAD_RESOURCE_LOCK_TOKEN: ownedToken || process.env.FLUENTREAD_RESOURCE_LOCK_TOKEN,
        FLUENTREAD_RESOURCE_LOCK_SLOT: ownedSlotDir ? path.basename(ownedSlotDir)
            : process.env.FLUENTREAD_RESOURCE_LOCK_SLOT || LEGACY_SLOT_NAME,
        FLUENTREAD_TEST_CONCURRENCY: String(options.concurrency),
        FLUENTREAD_TEST_CPU_TARGET: String(options.cpuTargetPercent),
        FLUENTREAD_TEST_MAX_WORKERS: String(options.maxWorkers),
    };
    console.log(`[resource-safe] CPU target ${options.cpuTargetPercent}%, maxWorkers ${options.maxWorkers}, concurrency ${options.concurrency}, command: ${options.command} ${options.args.join(' ')}`);
    return new Promise((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            cwd: PROJECT_ROOT,
            env,
            stdio: 'inherit',
            shell: false,
            detached: process.platform !== 'win32',
        });
        const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal =>
            [signal, () => signalProcessGroup(child, signal)]));
        for (const [signal, handler] of signalHandlers) process.on(signal, handler);
        child.once('error', (error) => {
            for (const [signal, handler] of signalHandlers) process.off(signal, handler);
            reject(error);
        });
        child.once('close', (code, signal) => {
            for (const [handledSignal, handler] of signalHandlers) process.off(handledSignal, handler);
            resolve({code, signal});
        });
    });
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        usage();
        return 0;
    }
    if (await hasInheritedLock()) {
        const result = await runChild(options);
        return result.code ?? 128 + (os.constants.signals[result.signal] || 1);
    }
    await acquireLock(options);
    try {
        const result = await runChild(options);
        return result.code ?? 128 + (os.constants.signals[result.signal] || 1);
    } finally {
        await releaseLock();
    }
}

// 编译入口复用同一锁、信号转发和退出码路径，不再增加一层 CLI 子进程。
export {main as runResourceSafe};

// Node canonicalizes entry paths unless preserve-symlinks is enabled; file URLs also encode spaces and Unicode.
let commandLineEntry = false;
if (process.argv[1]) {
    try {
        commandLineEntry = import.meta.url === pathToFileURL(process.argv[1]).href ||
            realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
    } catch {
        // Imported modules may have a synthetic or unavailable caller path.
    }
}
if (commandLineEntry) {
    main().then((code) => {
        process.exitCode = code;
    }).catch(async (error) => {
        await releaseLock().catch(() => {});
        console.error(`[resource-safe] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
